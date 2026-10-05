const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const socketAuth = require('../socketAuth');
const streamRooms = require('../streamRooms');

// Executa os handlers reais com banco e transporte isolados, sem tocar produção.
function criarServidor({ autorizado = true, bancoDisponivel = true } = {}) {
  const handlers = {};
  const endpoints = {};
  const enviados = [];
  const registros = [];
  const erros = [];
  const socketRegistry = new Map();
  const socketListeners = new Map();
  let conectar;
  const rooms = new Set();
  const socket = {
    id: 'socket-teste', usuario: { id: 7, nome: 'Teste' },
    rooms,
    on: (evento, callback) => {
      handlers[evento] = callback;
      if (!socketListeners.has(evento)) socketListeners.set(evento, []);
      socketListeners.get(evento).push(callback);
    },
    join: (room) => rooms.add(room),
    leave: (room) => rooms.delete(room),
    emit() {},
  };
  socketRegistry.set(socket.id, socket);
  const io = {
    use() {},
    sockets: { sockets: socketRegistry },
    on: (_evento, callback) => { conectar = callback; },
    emit: (evento, dados) => enviados.push({ destino: 'todos', evento, dados }),
    to: (destino) => ({ emit: (evento, dados) => enviados.push({ destino, evento, dados }) }),
  };
  const app = {
    use() {},
    get: (rota, handler) => { endpoints[rota] = handler; },
  };
  const express = Object.assign(() => app, { json: () => () => {} });
  const db = {
    initDb: async () => {},
    all: async () => [],
    get: async (sql, ...args) => {
      if (!bancoDisponivel) throw new Error('Banco indisponível');
      if (sql.startsWith('INSERT INTO')) {
        const id = 123 + registros.length;
        registros.push({ id, args });
        return { id };
      }
      return { servidor_id: 2 };
    },
  };
  const modules = {
    dotenv: { config() {} }, express,
    http: { createServer: () => ({ listen() {} }) },
    cors: () => () => {}, jsonwebtoken: {},
    'socket.io': { Server: function () { return io; } },
    './db': db,
    './socketAuth': socketAuth,
    './streamRooms': streamRooms,
    './routes/auth': {}, './routes/mensagens': {}, './routes/recuperacao': {},
    './routes/servidores': {
      router: {}, ehMembro: async () => autorizado, temPermissao: async () => autorizado,
    },
    './routes/amigos': { router: {}, compartilhamServidor: async () => autorizado },
    './eventosConta': { on() {} },
    './presenca': { socketsPorUsuario: new Map([[7, new Set(['socket-teste'])], [8, new Set(['amigo'])]]) },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../index.js'), 'utf8'), {
    require: (name) => {
      assert.ok(name in modules, `Dependência não isolada: ${name}`);
      return modules[name];
    },
    process: { env: {} }, console: { log() {}, error: (...args) => erros.push(args) },
  });
  conectar(socket);
  return { handlers, socketListeners, enviados, registros, endpoints, erros, socket, io, conectar };
}

async function enviar(servidor, evento, dados) {
  servidor.handlers[evento](dados);
  await new Promise(setImmediate);
}

test('chat transmite o identificador persistido pelo PostgreSQL', async () => {
  const servidor = criarServidor();
  await enviar(servidor, 'enviar-mensagem', { canalId: 3, conteudo: ' Olá ' });
  assert.equal(servidor.registros.length, 1);
  assert.equal(servidor.enviados[0].evento, 'nova-mensagem');
  assert.equal(servidor.enviados[0].dados.mensagem.id, servidor.registros[0].id);
  assert.equal(servidor.enviados[0].dados.mensagem.conteudo, 'Olá');
});

test('DM entrega o mesmo identificador persistido para remetente e destinatário', async () => {
  const servidor = criarServidor();
  await enviar(servidor, 'enviar-dm', { paraUsuarioId: 8, conteudo: 'Olá' });
  assert.equal(servidor.enviados.length, 2);
  assert.deepEqual(servidor.enviados.map((item) => item.destino).sort(), ['amigo', 'socket-teste']);
  for (const item of servidor.enviados) assert.equal(item.dados.mensagem.id, servidor.registros[0].id);
});

test('não persiste nem transmite chat ou DM sem acesso ao servidor', async () => {
  const servidor = criarServidor({ autorizado: false });
  await enviar(servidor, 'enviar-mensagem', { canalId: 3, conteudo: 'Olá' });
  await enviar(servidor, 'enviar-dm', { paraUsuarioId: 8, conteudo: 'Olá' });
  assert.equal(servidor.registros.length, 0);
  assert.equal(servidor.enviados.length, 0);
});

test('health indica indisponibilidade quando o banco não responde', async () => {
  for (const bancoDisponivel of [true, false]) {
    const servidor = criarServidor({ bancoDisponivel });
    let status = 200;
    let resultado;
    const res = {
      set() {}, status(code) { status = code; return this; },
      json(value) { resultado = value; },
    };
    await servidor.endpoints['/health']({}, res);
    assert.equal(status, bancoDisponivel ? 200 : 503);
    assert.equal(resultado.status, bancoDisponivel ? 'ok' : 'unavailable');
  }
});

test('espectador anônimo recebe apenas handlers de sala, sem chat, DM ou voz', () => {
  const servidor = criarServidor();
  const handlers = {};
  const visitante = {
    id: 'espectador', espectadorAnonimo: true,
    on: (evento, callback) => { handlers[evento] = callback; },
    join() {}, leave() {}, emit() {},
  };
  servidor.io.sockets.sockets.set(visitante.id, visitante);

  servidor.conectar(visitante);

  assert.equal(typeof handlers['salas:listar'], 'function');
  assert.equal(typeof handlers['salas:entrar'], 'function');
  assert.equal(handlers['enviar-mensagem'], undefined);
  assert.equal(handlers['enviar-dm'], undefined);
  assert.equal(handlers['entrar-canal-voz'], undefined);
});

test('disconnect do anfitrião pelo wiring preserva a sala durante a janela de reconexão', async () => {
  const servidor = criarServidor();
  const viewerHandlers = {};
  const viewerListeners = new Map();
  const viewerRooms = new Set();
  const visitante = {
    id: 'espectador', espectadorAnonimo: true, rooms: viewerRooms,
    on: (evento, callback) => {
      viewerHandlers[evento] = callback;
      if (!viewerListeners.has(evento)) viewerListeners.set(evento, []);
      viewerListeners.get(evento).push(callback);
    },
    join: (room) => viewerRooms.add(room),
    leave: (room) => viewerRooms.delete(room),
    emit() {},
  };
  servidor.io.sockets.sockets.set(visitante.id, visitante);
  servidor.conectar(visitante);

  const created = await new Promise((resolve) => {
    servidor.handlers['salas:criar']({ name: 'Sessão', visibility: 'public' }, resolve);
  });
  const joined = await new Promise((resolve) => {
    viewerHandlers['salas:entrar']({ roomId: created.room.id }, resolve);
  });
  assert.equal(joined.ok, true);
  assert.equal(viewerRooms.has(`sala-${created.room.id}`), true);

  for (const handler of servidor.socketListeners.get('disconnect')) handler('transport close');

  assert.equal(servidor.enviados.some((item) => item.evento === 'sala:encerrada'), false);
  assert.equal(viewerRooms.has(`sala-${created.room.id}`), true);
});

test('sinalização WebRTC legada só chega a outro socket no mesmo canal de voz', () => {
  const servidor = criarServidor();
  const peer = { id: 'peer', canalVozAtual: 'canal-b' };
  servidor.socket.canalVozAtual = 'canal-a';
  servidor.io.sockets.sockets.set(peer.id, peer);

  servidor.handlers['webrtc-oferta']({ para: peer.id, oferta: { type: 'offer' } });
  assert.equal(servidor.enviados.some((item) => item.destino === peer.id && item.evento === 'webrtc-oferta'), false);

  peer.canalVozAtual = 'canal-a';
  servidor.handlers['webrtc-oferta']({ para: peer.id, oferta: { type: 'offer' } });
  assert.equal(servidor.enviados.filter((item) => item.destino === peer.id && item.evento === 'webrtc-oferta').length, 1);
});
