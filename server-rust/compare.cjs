// Compara o protótipo em release com o servidor Node.js do próprio repositório.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../client/node_modules/socket.io-client');
const bcrypt = require('../server/node_modules/bcryptjs');
const jwt = require('../server/node_modules/jsonwebtoken');
const { verifyScreenRooms } = require('./tests/screen-rooms.cjs');

const database = new URL(process.env.ASTRALIS_TEST_DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/astralis_rust_test');
assert.equal(database.search, '');
process.env.DATABASE_URL = database.href;
const secret = randomUUID();
const port = Number(process.env.ASTRALIS_RUST_PORT || 3301);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const baseUrl = `http://127.0.0.1:${port}`;
const { db, initDb } = require('../server/db');

const jsonPost = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
const USERS = ['Ana', 'Bruno', 'Cris'];
const password = 'senha-local-teste';
const dmCount = 4000;
const concurrency = 16;
const rounds = [
  ['Node.js', 'Rust'],
  ['Rust', 'Node.js'],
  ['Node.js', 'Rust'],
];
const verifiedRooms = new Set();

async function seed() {
  const key = randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const emails = USERS.map((name) => `${name}+${key}@example.test`);
  const { rows } = await db.query(
    `INSERT INTO usuarios (nome, email, senha_hash, versao_sessao)
     SELECT nome, email, $3, 2 FROM unnest($1::text[], $2::text[]) AS fixture(nome, email)
     RETURNING id, nome, email`,
    [USERS, emails, hash],
  );
  const users = emails.map((email) => rows.find((row) => row.email === email));
  await db.query(
    `INSERT INTO amizades (usuario_a_id, usuario_b_id, remetente_id, estado)
     VALUES (LEAST($1::bigint, $2::bigint), GREATEST($1, $2), $1, 'aceita')`,
    [users[0].id, users[1].id],
  );
  return users;
}

async function request(url, options) {
  return fetch(baseUrl + url, { ...options, signal: AbortSignal.timeout(5000) });
}

async function login({ email, id, nome }) {
  const res = await request('/api/login', {
    ...jsonPost, body: JSON.stringify({ email, senha: password }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const { token, usuario } = await res.json();
  assert.deepEqual(usuario, {
    id, nome, email, avatar_cor: '#5865f2', avatar_url: null, banner_url: null, status: 'Disponível',
  });
  assert.equal(jwt.verify(token, secret).versao_sessao, 2);
  return token;
}

function connect(token, sockets) {
  const socket = io(baseUrl, { auth: { token }, forceNew: true, reconnection: false, timeout: 4000 });
  sockets.push(socket);
  return socket;
}

async function listening(process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`Servidor saiu com código ${process.exitCode}.`);
    const response = await request('/').catch(() => null);
    if (response?.ok) {
      await response.text();
      return;
    }
    await sleep(50);
  }
  throw new Error('Servidor não respondeu na porta de teste.');
}

async function connected(socket) {
  await once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
  if (socket.io.engine.transport.name === 'polling') {
    await once(socket.io.engine, 'upgrade', { signal: AbortSignal.timeout(5000) });
  }
  assert.equal(socket.io.engine.transport.name, 'websocket');
}

function readMetrics(pid) {
  if (process.platform !== 'win32') return null;
  const result = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pid} | Select-Object CPU,WorkingSet64 | ConvertTo-Json -Compress`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return JSON.parse(result);
}

async function workload(sender, recipient, count, pid) {
  const latencies = [];
  const pending = new Map();
  const prefix = `carga-${randomUUID()}`;
  let sent = 0;
  function send() {
    const conteudo = `${prefix}-${++sent}`;
    pending.set(conteudo, performance.now());
    sender.socket.emit('enviar-dm', { paraUsuarioId: recipient.id, conteudo });
  }
  const before = pid ? readMetrics(pid) : null;
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      recipient.socket.off('nova-dm', receive);
      reject(new Error(`A carga recebeu ${latencies.length}/${count} mensagens.`));
    }, 30000);
    function receive({ mensagem }) {
      const started = pending.get(mensagem.conteudo);
      if (started === undefined) return;
      latencies.push(performance.now() - started);
      pending.delete(mensagem.conteudo);
      if (sent < count) send();
      if (latencies.length === count) {
        clearTimeout(timeout);
        recipient.socket.off('nova-dm', receive);
        resolve();
      }
    }
    recipient.socket.on('nova-dm', receive);
    for (let i = 0; i < concurrency; i++) send();
  });
  const duration = performance.now() - start;
  if (!pid) return;
  const after = readMetrics(pid);
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    'p50 ms': +sorted[Math.ceil(count * 0.5) - 1].toFixed(2),
    'p95 ms': +sorted[Math.ceil(count * 0.95) - 1].toFixed(2),
    'DM/s': Math.round(count * 1000 / duration),
    ...(after && {
      'CPU ms': Math.round((after.CPU - before.CPU) * 1000),
      'RAM MiB após carga': +(after.WorkingSet64 / 2 ** 20).toFixed(1),
    }),
  };
}

async function checkFlow(users, sockets) {
  const [ana, bruno, cris] = users;
  const missing = connect(undefined, sockets);
  assert.match((await once(missing, 'connect_error', { signal: AbortSignal.timeout(5000) }))[0].message,
    /Token não fornecido/);
  const stale = jwt.sign({ id: ana.id, nome: ana.nome, versao_sessao: 1 }, secret, { expiresIn: '1h' });
  const expired = connect(stale, sockets);
  assert.match((await once(expired, 'connect_error', { signal: AbortSignal.timeout(5000) }))[0].message,
    /Token inválido/);
  const wrongPassword = await request('/api/login', {
    ...jsonPost, body: JSON.stringify({ email: ana.email, senha: 'incorreta' }),
  });
  assert.equal(wrongPassword.status, 401);
  await wrongPassword.text();
  for (const user of users) {
    user.token = await login(user);
    user.socket = connect(user.token, sockets);
    await connected(user.socket);
  }
  const existingToken = jwt.sign({
    id: bruno.id, nome: bruno.nome, versao_sessao: 2,
  }, secret, { expiresIn: '30d' });
  const secondTab = connect(existingToken, sockets);
  await connected(secondTab);

  const queryHistory = (token, recipientId) => request(`/api/mensagens-diretas/${recipientId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const denied = await queryHistory(cris.token, bruno.id);
  assert.equal(denied.status, 403);
  await denied.text();
  const forbidden = `proibida-${randomUUID()}`;
  const forbiddenDelivery = once(bruno.socket, 'nova-dm', { signal: AbortSignal.timeout(200) });
  cris.socket.emit('enviar-dm', { paraUsuarioId: bruno.id, conteudo: forbidden });
  await assert.rejects(forbiddenDelivery, { name: 'AbortError' });

  const expected = 'Olá do teste!';
  const deliveries = [ana.socket, bruno.socket, secondTab].map((socket) =>
    once(socket, 'nova-dm', { signal: AbortSignal.timeout(5000) }));
  ana.socket.emit('enviar-dm', { paraUsuarioId: bruno.id, conteudo: ` ${expected} ` });
  const [[echo], [received], [second]] = await Promise.all(deliveries);
  assert.deepEqual(echo, received);
  assert.deepEqual(second, received);
  assert.equal(received.comUsuarioId, bruno.id);
  assert.equal(received.deUsuarioId, ana.id);
  assert.equal(received.mensagem.remetente_id, ana.id);
  assert.equal(received.mensagem.conteudo, expected);
  assert.ok(received.mensagem.id > 0);
  const history = await queryHistory(bruno.token, ana.id);
  assert.equal(history.status, 200);
  const messages = await history.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, received.mensagem.id);
  assert.equal(messages[0].conteudo, expected);
  secondTab.disconnect();
  const replyDelivery = once(ana.socket, 'nova-dm', { signal: AbortSignal.timeout(5000) });
  bruno.socket.emit('enviar-dm', { paraUsuarioId: ana.id, conteudo: 'Olá, Ana!' });
  const [reply] = await replyDelivery;
  assert.equal(reply.mensagem.remetente_id, bruno.id);
  assert.equal(reply.mensagem.conteudo, 'Olá, Ana!');
  const persisted = await db.query('SELECT id FROM mensagens_diretas WHERE conteudo = $1', [forbidden]);
  assert.equal(persisted.rowCount, 0);
}

async function checkCalls([caller, callee, other], sockets) {
  const calleeTab = connect(callee.token, sockets);
  await connected(calleeTab);
  const received = once(callee.socket, 'chamada:recebida', { signal: AbortSignal.timeout(5000) });
  const receivedElsewhere = once(calleeTab, 'chamada:recebida', { signal: AbortSignal.timeout(5000) });
  const ask = (socket, event, input) => socket.timeout(5000).emitWithAck(event, input);
  const started = await ask(caller.socket, 'chamada:iniciar', { paraUsuarioId: callee.id });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.call.status, 'ringing');
  assert.deepEqual((await received)[0].call, started.call);
  assert.deepEqual((await receivedElsewhere)[0].call, started.call);
  const input = { callId: started.call.id };
  const rejected = await ask(other.socket, 'chamada:aceitar', input);
  assert.equal(rejected.code, 'forbidden');
  const otherTabDismissed = once(calleeTab, 'chamada:encerrada', { signal: AbortSignal.timeout(5000) });
  const accepted = await ask(callee.socket, 'chamada:aceitar', input);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.call.status, 'active');
  assert.equal((await otherTabDismissed)[0].reason, 'answered-elsewhere');
  const channel = accepted.call.canalId;
  assert.equal((await ask(calleeTab, 'entrar-canal-voz', channel)).code, 'forbidden');
  assert.equal((await ask(caller.socket, 'entrar-canal-voz', channel)).ok, true);
  const newPeer = once(caller.socket, 'novo-peer', { signal: AbortSignal.timeout(5000) });
  assert.equal((await ask(callee.socket, 'entrar-canal-voz', channel)).ok, true);
  assert.equal((await newPeer)[0].usuarioId, callee.id);

  const signal = once(callee.socket, 'webrtc-oferta', { signal: AbortSignal.timeout(5000) });
  const offer = { type: 'offer', sdp: 'compatibility-test' };
  caller.socket.emit('webrtc-oferta', { para: callee.socket.id, oferta: offer });
  assert.deepEqual((await signal)[0], { de: caller.socket.id, oferta: offer });
  const unselected = once(calleeTab, 'webrtc-oferta', { signal: AbortSignal.timeout(200) });
  caller.socket.emit('webrtc-oferta', { para: calleeTab.id, oferta: offer });
  await assert.rejects(unselected, { name: 'AbortError' });

  const stopped = once(callee.socket, 'tela-parada', { signal: AbortSignal.timeout(5000) });
  caller.socket.emit('tela-parada');
  assert.equal((await stopped)[0].socketId, caller.socket.id);
  const ended = once(callee.socket, 'chamada:encerrada', { signal: AbortSignal.timeout(5000) });
  assert.equal((await ask(caller.socket, 'chamada:encerrar', input)).ok, true);
  assert.deepEqual((await ended)[0], { callId: started.call.id, reason: 'ended' });
  calleeTab.disconnect();
}

async function run(implementation) {
  assert.equal(await request('/').then(() => true, () => false), false, 'Porta de teste ocupada.');
  const users = await seed();
  const sockets = [];
  const node = implementation === 'Node.js';
  const rustBinary = process.platform === 'win32' ? 'astralis-server.exe' : 'astralis-server';
  const command = node ? process.execPath : path.join(__dirname, 'target', 'release', rustBinary);
  const args = node ? [path.join(__dirname, '..', 'server', 'index.js')] : [];
  // Executa fora de server/ para que dotenv não carregue o .env do backend publicado.
  const server = spawn(command, args, {
    cwd: __dirname,
    env: {
      ...process.env, PORT: String(port), ASTRALIS_RUST_PORT: String(port),
      JWT_SECRET: secret, ASTRALIS_TEST_JWT_SECRET: secret,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await Promise.race([
      listening(server),
      once(server, 'error').then(([error]) => { throw error; }),
    ]);
    await checkFlow(users, sockets);
    await checkCalls(users, sockets);
    if (!verifiedRooms.has(implementation)) {
      await verifyScreenRooms(baseUrl, users.map((user) => user.token));
      verifiedRooms.add(implementation);
    }
    console.log(`${implementation}: login, DM, histórico, chamada, sinalização WebRTC e salas OK`);
    await workload(users[0], users[1], 1000);
    return { servidor: implementation, ...await workload(users[0], users[1], dmCount, server.pid) };
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (server.exitCode === null && server.signalCode === null && server.pid) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    const ids = users.map(({ id }) => id);
    await db.query(
      'DELETE FROM mensagens_diretas WHERE remetente_id = ANY($1::bigint[]) OR destinatario_id = ANY($1::bigint[])',
      [ids],
    );
    await db.query('DELETE FROM usuarios WHERE id = ANY($1::bigint[])', [ids]);
  }
}

(async () => {
  try {
    await initDb();
    const results = [];
    for (let index = 0; index < rounds.length; index++) {
      for (const implementation of rounds[index]) {
        results.push({ rodada: index + 1, ...await run(implementation) });
      }
    }
    console.table(results);
  } finally {
    await db.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
