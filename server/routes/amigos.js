const express = require('express');
const autenticar = require('../middleware/autenticar');
const { estaOnline } = require('../presenca');
const { createFriendshipService, FriendshipError } = require('../friendships');

let productionService;
function service() {
  if (!productionService) productionService = createFriendshipService(require('../db'));
  return productionService;
}

function criarRouterAmigos({ amizades, autenticar: authenticate = autenticar, online = estaOnline, now = Date.now } = {}) {
  const router = express.Router();
  const backend = () => amizades || service();
  const publicUser = (user) => ({ ...user, online: online(user.id) });
  const publicRequest = (request) => ({ ...request, usuario: publicUser(request.usuario) });
  const notify = (req, ids, tipo) => req.app.get('notificarAmizades')?.(ids, { tipo });
  const attempts = new Map();
  const windowMs = 10 * 60 * 1000;
  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof FriendshipError) {
        return res.status(error.status).json({ erro: error.message, codigo: error.code });
      }
      next(error);
    }
  };
  router.use(authenticate);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/amigos', route(async (req, res) => {
    res.json((await backend().listFriends(req.usuario.id)).map(publicUser));
  }));

  router.get('/amigos/pedidos', route(async (req, res) => {
    const requests = await backend().listRequests(req.usuario.id);
    res.json({
      recebidos: requests.recebidos.map(publicRequest),
      enviados: requests.enviados.map(publicRequest),
    });
  }));

  router.post('/amigos/pedidos', route(async (req, res) => {
    const time = now();
    for (const [id, attempt] of attempts) {
      if (attempt.expiresAt <= time) attempts.delete(id);
    }
    const userId = Number(req.usuario.id);
    const attempt = attempts.get(userId) || { count: 0, expiresAt: time + windowMs };
    if (attempt.count >= 30 || (!attempts.has(userId) && attempts.size >= 10_000)) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.expiresAt - time) / 1000))));
      return res.status(429).json({ erro: 'Muitos pedidos de amizade. Aguarde alguns minutos e tente novamente.' });
    }
    attempt.count += 1;
    attempts.set(userId, attempt);
    const result = await backend().sendRequest(req.usuario.id, req.body?.nome);
    notify(req, result.usuarioIds, 'pedido-enviado');
    res.status(201).json({ mensagem: 'Pedido de amizade enviado.', pedido: publicRequest(result.pedido) });
  }));

  router.post('/amigos/pedidos/:id/aceitar', route(async (req, res) => {
    const result = await backend().acceptRequest(req.usuario.id, req.params.id);
    notify(req, result.usuarioIds, 'pedido-aceito');
    res.json({ mensagem: 'Pedido de amizade aceito.' });
  }));

  router.delete('/amigos/pedidos/:id', route(async (req, res) => {
    const result = await backend().deleteRequest(req.usuario.id, req.params.id);
    notify(req, result.usuarioIds, 'pedido-removido');
    res.json({ mensagem: 'Pedido de amizade removido.' });
  }));

  router.delete('/amigos/:id', route(async (req, res) => {
    const result = await backend().removeFriend(req.usuario.id, req.params.id);
    notify(req, result.usuarioIds, 'amizade-removida');
    res.json({ mensagem: 'Pessoa removida da lista de amigos.' });
  }));

  router.get('/mensagens-diretas/:usuarioId', route(async (req, res) => {
    const otherId = Number(req.params.usuarioId);
    if (!(await backend().canMessage(req.usuario.id, otherId))) {
      return res.status(403).json({ erro: 'Adicione essa pessoa como amiga para conversar.' });
    }
    res.json(await backend().listMessages(req.usuario.id, otherId));
  }));
  return router;
}

module.exports = {
  router: criarRouterAmigos(),
  criarRouterAmigos,
  saoAmigos: (userId, otherId) => service().areFriends(userId, otherId),
  amigosDe: async (userId) => (await service().listFriends(userId)).map((user) => user.id),
  compartilhamServidor: (userId, otherId) => service().shareServer(userId, otherId),
  podemConversar: (userId, otherId) => service().canMessage(userId, otherId),
};
