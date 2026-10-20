const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const express = require('express');
const jwt = require('jsonwebtoken');
const { friendshipSchema, createFriendshipService } = require('../friendships');
const { criarRouterAmigos } = require('../routes/amigos');
const { criarAutenticador } = require('../middleware/autenticar');

process.env.JWT_SECRET = 'friendship-tests-local-secret';

function database(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT, senha_hash TEXT,
      avatar_cor TEXT DEFAULT '#9988dd', avatar_url TEXT, status TEXT DEFAULT 'Disponível',
      versao_sessao INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS membros_servidor (servidor_id INTEGER, usuario_id INTEGER);
    CREATE TABLE IF NOT EXISTS mensagens_diretas (
      id INTEGER PRIMARY KEY, remetente_id INTEGER, destinatario_id INTEGER,
      conteudo TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  sqlite.exec(friendshipSchema('sqlite'));
  const db = {
    all: async (sql, ...args) => sqlite.prepare(sql).all(...args),
    get: async (sql, ...args) => sqlite.prepare(sql).get(...args),
    run: async (sql, ...args) => sqlite.prepare(sql).run(...args),
  };
  return { sqlite, db, service: createFriendshipService(db), close: () => sqlite.close() };
}

function seed(sqlite) {
  const insert = sqlite.prepare('INSERT INTO usuarios (id, nome, email, senha_hash) VALUES (?, ?, ?, ?)');
  for (const [id, name] of [[1, 'Ana'], [2, 'Bruno'], [3, 'Clara'], [4, 'Alex'], [5, 'alex'], [6, 'Star#Tag']]) {
    insert.run(id, name, `${id}@private.example.test`, `private-password-hash-${id}`);
  }
  sqlite.exec(`
    INSERT INTO membros_servidor VALUES (10, 1), (10, 3);
    INSERT INTO mensagens_diretas (remetente_id, destinatario_id, conteudo) VALUES
      (1, 2, 'DM entre amigos'), (3, 1, 'DM do servidor'), (2, 3, 'Outra conversa');
  `);
}

async function server(t) {
  const storage = database();
  seed(storage.sqlite);
  t.after(() => storage.close());
  const events = [];
  let time = 1000;
  const app = express();
  app.use(express.json());
  app.set('notificarAmizades', (ids, detail) => events.push({ ids, ...detail }));
  app.use('/api', criarRouterAmigos({
    amizades: storage.service,
    autenticar: criarAutenticador((id) => storage.db.get('SELECT versao_sessao FROM usuarios WHERE id = ?', id)),
    online: (id) => id === 2,
    now: () => time,
  }));
  app.use((error, req, res, next) => {
    void req; void next;
    res.status(500).json({ erro: error.message });
  });
  const listener = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const request = async (user, path, { method = 'GET', body, token } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers.authorization = `Bearer ${token || jwt.sign({ id: user, versao_sessao: 0 }, process.env.JWT_SECRET)}`;
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { ...storage, request, events, advance: (ms) => { time += ms; } };
}

const send = (s, from = 1, nome = 'Bruno') => s.request(from, '/amigos/pedidos', { method: 'POST', body: { nome } });
const accept = (s, requestId, user = 2) => s.request(user, `/amigos/pedidos/${requestId}/aceitar`, { method: 'POST' });

test('schema é aditivo e impede pares duplicados, autoamizade e remetente externo', (t) => {
  const { sqlite, close } = database();
  t.after(close);
  seed(sqlite);
  const insert = sqlite.prepare('INSERT INTO amizades (usuario_a_id, usuario_b_id, remetente_id) VALUES (?, ?, ?)');
  assert.throws(() => insert.run(1, 1, 1), /CHECK/);
  assert.throws(() => insert.run(2, 1, 2), /CHECK/);
  assert.throws(() => insert.run(1, 2, 3), /CHECK/);
  assert.throws(() => insert.run(1, 99, 1), /FOREIGN KEY/);
  insert.run(1, 2, 1);
  assert.throws(() => insert.run(1, 2, 2), /UNIQUE/);
  sqlite.exec(friendshipSchema('sqlite'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM amizades').get().total, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM usuarios').get().total, 6);
  sqlite.exec('DELETE FROM usuarios WHERE id = 2');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM amizades').get().total, 0);
});

test('amizade aceita persiste depois de reabrir banco e vale nos dois sentidos sem servidor', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'astralis-friendship-'));
  let reopened;
  t.after(() => {
    reopened?.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'astralis-friendship-')));
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'friends.db');
  let first = database(path);
  seed(first.sqlite);
  try {
    const { pedido } = await first.service.sendRequest(1, 'bruno');
    assert.equal(await first.service.areFriends(1, 2), false);
    await first.service.acceptRequest(2, pedido.id);
  } finally {
    first.close();
  }
  reopened = database(path);
  assert.equal(await reopened.service.areFriends(1, 2), true);
  assert.equal(await reopened.service.areFriends(2, 1), true);
  assert.deepEqual((await reopened.service.listFriends(1)).map((u) => u.id), [2]);
  assert.deepEqual((await reopened.service.listFriends(2)).map((u) => u.id), [1]);
  assert.equal(await reopened.service.shareServer(1, 2), false);
});

test('lista distingue amigos aceitos de pedidos, inclui presença e não expõe dados privados', async (t) => {
  const s = await server(t);
  assert.deepEqual((await s.request(1, '/amigos')).body, []);
  const created = await send(s);
  assert.equal(created.status, 201);
  assert.equal(created.body.pedido.usuario.online, true);
  const outgoing = (await s.request(1, '/amigos/pedidos')).body;
  const incoming = (await s.request(2, '/amigos/pedidos')).body;
  assert.deepEqual(outgoing.recebidos, []);
  assert.equal(outgoing.enviados[0].usuario.id, 2);
  assert.equal(incoming.recebidos[0].usuario.id, 1);
  assert.deepEqual(incoming.enviados, []);
  assert.deepEqual((await s.request(3, '/amigos/pedidos')).body, { recebidos: [], enviados: [] });
  assert.equal(JSON.stringify([created.body, outgoing, incoming]).includes('private'), false);
  await accept(s, created.body.pedido.id);
  const friends = await s.request(1, '/amigos');
  assert.equal(friends.headers.get('cache-control'), 'no-store');
  assert.deepEqual(friends.body.map((u) => u.id), [2]);
  assert.equal(friends.body[0].online, true);
  assert.deepEqual((await s.request(1, '/amigos/pedidos')).body, { recebidos: [], enviados: [] });
  assert.deepEqual(s.events.map((e) => e.tipo), ['pedido-enviado', 'pedido-aceito']);
  assert.deepEqual(s.events.map((e) => e.ids), [[1, 2], [1, 2]]);
});

test('busca exige nome exato e desambigua homônimos pelo identificador', async (t) => {
  const s = await server(t);
  for (const name of ['', ' ', 2, {}, 'x'.repeat(129)]) {
    assert.equal((await send(s, 1, name)).status, 400);
  }
  assert.equal((await send(s, 1, 'Ana')).body.codigo, 'AUTO_AMIZADE');
  assert.equal((await send(s, 1, 'Brun')).status, 404);
  assert.equal((await send(s, 1, 'Alex')).body.codigo, 'NOME_AMBIGUO');
  assert.equal((await send(s, 1, 'Bruno#4')).status, 404);
  assert.equal((await send(s, 1, 'Alex#4')).body.pedido.usuario.id, 4);
  assert.equal((await send(s, 1, '#5')).body.pedido.usuario.id, 5);
  assert.equal((await send(s, 1, 'Star#Tag#6')).body.pedido.usuario.id, 6);
  assert.equal((await send(s, 1, '#9007199254740993')).status, 404);
});

test('convites simultâneos e cruzados não duplicam nem aceitam amizade automaticamente', async (t) => {
  const s = await server(t);
  const results = await Promise.all([send(s), send(s, 2, 'Ana')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS total FROM amizades').get().total, 1);
  assert.equal(await s.service.areFriends(1, 2), false);
  const row = s.sqlite.prepare('SELECT * FROM amizades').get();
  const receiver = row.remetente_id === 1 ? 2 : 1;
  assert.equal((await accept(s, row.id, receiver)).status, 200);
  assert.equal((await send(s)).body.codigo, 'AMIZADE_EXISTENTE');
  assert.equal(s.events.length, 2);
});

test('todas as rotas exigem sessão atual, sem efeitos quando o token está ausente ou revogado', async (t) => {
  const s = await server(t);
  for (const [method, path] of [
    ['GET', '/amigos'], ['GET', '/amigos/pedidos'], ['POST', '/amigos/pedidos'],
    ['POST', '/amigos/pedidos/1/aceitar'], ['DELETE', '/amigos/pedidos/1'], ['DELETE', '/amigos/2'],
    ['GET', '/mensagens-diretas/2'],
  ]) {
    assert.equal((await s.request(null, path, { method, body: method === 'POST' ? { nome: 'Bruno' } : undefined })).status, 401);
  }
  assert.equal((await s.request(1, '/amigos', { token: 'invalid' })).status, 401);
  s.sqlite.exec('UPDATE usuarios SET versao_sessao = 1 WHERE id = 1');
  assert.equal((await send(s)).status, 401);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS total FROM amizades').get().total, 0);
  assert.deepEqual(s.events, []);
});

test('só destinatário aceita e terceiros não podem recusar, cancelar ou remover amizades', async (t) => {
  const s = await server(t);
  const id = (await send(s)).body.pedido.id;
  assert.equal((await accept(s, id, 1)).status, 404);
  assert.equal((await accept(s, id, 3)).status, 404);
  assert.equal((await s.request(3, `/amigos/pedidos/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await s.request(1, '/amigos/pedidos/nope/aceitar', { method: 'POST' })).status, 400);
  assert.equal((await accept(s, id)).status, 200);
  assert.equal((await accept(s, id)).status, 404);
  assert.equal((await s.request(1, `/amigos/pedidos/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await s.request(3, '/amigos/2', { method: 'DELETE' })).status, 404);
  assert.equal(await s.service.areFriends(1, 2), true);
  assert.equal((await s.request(2, '/amigos/1', { method: 'DELETE' })).status, 200);
  assert.equal(await s.service.areFriends(1, 2), false);
  assert.equal(s.events.at(-1).tipo, 'amizade-removida');
  assert.deepEqual(s.events.at(-1).ids, [1, 2]);
});

test('destinatário recusa e remetente cancela, permitindo novo convite depois', async (t) => {
  const s = await server(t);
  const first = (await send(s)).body.pedido.id;
  assert.equal((await s.request(2, `/amigos/pedidos/${first}`, { method: 'DELETE' })).status, 200);
  const second = (await send(s)).body.pedido.id;
  assert.equal((await s.request(1, `/amigos/pedidos/${second}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await s.request(2, '/amigos/pedidos')).body, { recebidos: [], enviados: [] });
  assert.deepEqual(s.events.map((e) => e.tipo), ['pedido-enviado', 'pedido-removido', 'pedido-enviado', 'pedido-removido']);
});

test('DM permite amigos sem servidor, preserva contatos de servidor e bloqueia terceiros', async (t) => {
  const s = await server(t);
  assert.equal((await s.request(1, '/mensagens-diretas/2')).status, 403);
  const legacy = await s.request(1, '/mensagens-diretas/3');
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.map((m) => m.conteudo), ['DM do servidor']);
  assert.equal((await s.request(1, '/mensagens-diretas/1')).status, 403);
  assert.equal((await s.request(1, '/mensagens-diretas/NaN')).status, 403);
  const id = (await send(s)).body.pedido.id;
  assert.equal((await s.request(1, '/mensagens-diretas/2')).status, 403);
  await accept(s, id);
  const dm = await s.request(1, '/mensagens-diretas/2');
  assert.equal(dm.status, 200);
  assert.deepEqual(dm.body.map((m) => m.conteudo), ['DM entre amigos']);
  assert.equal((await s.request(3, '/mensagens-diretas/2')).status, 403);
  await s.request(1, '/amigos/2', { method: 'DELETE' });
  assert.equal((await s.request(1, '/mensagens-diretas/2')).status, 403);
});

test('limita tentativas por conta e libera após a janela sem bloquear outro usuário', async (t) => {
  const s = await server(t);
  for (let i = 0; i < 30; i += 1) assert.equal((await send(s, 1, 'Inexistente')).status, 404);
  const limited = await send(s);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '600');
  assert.equal((await send(s, 3, 'Bruno')).status, 201);
  s.advance(10 * 60 * 1000);
  assert.equal((await send(s)).status, 201);
});
