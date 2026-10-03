const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSocketAuthMiddleware } = require('../socketAuth');

function middlewareDeTeste({ verifyToken = (_token, callback) => callback(null, { id: 7, versao_sessao: 2, nome: 'Host' }), getSessionVersion = async () => 2 } = {}) {
  return createSocketAuthMiddleware({ verifyToken, getSessionVersion });
}

function socket(auth) {
  return { handshake: { auth } };
}

function executar(middleware, conexao) {
  return new Promise((resolve) => middleware(conexao, (erro) => resolve(erro || null)));
}

test('socket auth: visitante sem token recebe apenas identidade de espectador', async () => {
  let verificouToken = false;
  const middleware = middlewareDeTeste({
    verifyToken: () => { verificouToken = true; },
  });
  const visitante = socket({ modo: 'espectador' });

  const erro = await executar(middleware, visitante);
  assert.equal(erro, null);
  assert.equal(visitante.espectadorAnonimo, true);
  assert.equal(visitante.usuario, undefined);
  assert.equal(verificouToken, false);
});

test('socket auth: visitantes não podem declarar modo diferente nem conectar sem token', async () => {
  const middleware = middlewareDeTeste();
  const erro = await executar(middleware, socket({ modo: 'anfitriao' }));
  assert.match(erro?.message || '', /Token não fornecido/);
});

test('socket auth: token válido continua autenticando anfitriões normalmente', async () => {
  const anfitriao = socket({ token: 'token-valido', modo: 'espectador' });
  const erro = await executar(middlewareDeTeste(), anfitriao);
  assert.equal(erro, null);
  assert.equal(anfitriao.usuario.id, 7);
  assert.equal(anfitriao.espectadorAnonimo, undefined);
});

test('socket auth: visitante não pode usar token revogado ou inválido', async () => {
  const tokenInvalido = await executar(middlewareDeTeste({
    verifyToken: (_token, callback) => callback(new Error('inválido')),
  }), socket({ token: 'ruim', modo: 'espectador' }));
  assert.match(tokenInvalido?.message || '', /Token inválido/);

  const versaoAntiga = await executar(middlewareDeTeste({ getSessionVersion: async () => 3 }), socket({ token: 'antigo' }));
  assert.match(versaoAntiga?.message || '', /Token inválido/);
});
