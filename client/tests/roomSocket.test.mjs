import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitirSolicitacaoSala } from '../src/roomSocket.mjs';

class SocketDeTeste {
  connected = true;
  listeners = new Map();
  emissions = [];

  on(event, listener) {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, data, callback) {
    this.emissions.push({ event, data, callback });
  }

  dispatch(event, data) {
    for (const listener of this.listeners.get(event) || []) listener(data);
  }
}

test('retorna erro quando o servidor conectado não confirma a criação da sala', async () => {
  const socket = new SocketDeTeste();
  const resultado = await emitirSolicitacaoSala(socket, 'salas:criar', { name: 'Jogo' }, {
    responseTimeoutMs: 20,
  });

  assert.equal(socket.emissions[0].event, 'salas:criar');
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /não respondeu/i);
});

test('espera o servidor conectar antes de listar as salas', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, {
    connectionTimeoutMs: 50,
    responseTimeoutMs: 50,
  });

  assert.equal(socket.emissions.length, 0);
  socket.connected = true;
  socket.dispatch('connect');
  socket.emissions[0].callback({ ok: true, rooms: [] });

  assert.deepEqual(await pendente, { ok: true, rooms: [] });
});

test('falha imediatamente se a autenticação do socket é recusada', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, {
    connectionTimeoutMs: 50,
  });

  socket.dispatch('connect_error', new Error('Token não fornecido.'));
  const resultado = await pendente;
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /conexão/i);
  assert.equal(socket.emissions.length, 0);
});

test('mantém a listagem pendente durante falha temporária e envia quando a conexão recupera', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  socket.active = true;
  let concluida = false;
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, {
    connectionTimeoutMs: 100,
    responseTimeoutMs: 100,
  }).then((resultado) => { concluida = true; return resultado; });

  socket.dispatch('connect_error', new Error('xhr poll error'));
  await Promise.resolve();
  assert.equal(concluida, false);
  assert.equal(socket.emissions.length, 0);
  socket.connected = true;
  socket.dispatch('connect');
  socket.emissions[0].callback({ ok: true, rooms: [{ id: 'recuperada' }] });

  assert.deepEqual(await pendente, { ok: true, rooms: [{ id: 'recuperada' }] });
  assert.equal([...socket.listeners.values()].every((listeners) => listeners.size === 0), true);
});

test('a falha temporária continua limitada pelo prazo de conexão', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  socket.active = true;
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, { connectionTimeoutMs: 15 });
  socket.dispatch('connect_error', new Error('xhr poll error'));

  const resultado = await pendente;
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /demorou/i);
});

test('cancelar uma listagem antes da conexão limpa os listeners e impede envio posterior', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  const controller = new AbortController();
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, {
    signal: controller.signal,
    connectionTimeoutMs: 100,
  });
  controller.abort();

  assert.deepEqual(await pendente, { ok: false, cancelled: true });
  socket.connected = true;
  socket.dispatch('connect');
  assert.equal(socket.emissions.length, 0);
  assert.equal([...socket.listeners.values()].every((listeners) => listeners.size === 0), true);
});

test('nova tentativa reabre o socket quando o servidor havia recusado a conexão', async () => {
  const socket = new SocketDeTeste();
  socket.connected = false;
  socket.active = false;
  let tentouConectar = false;
  socket.connect = () => {
    tentouConectar = true;
    socket.active = true;
    socket.connected = true;
    socket.dispatch('connect');
  };
  const pendente = emitirSolicitacaoSala(socket, 'salas:listar', {}, { connectionTimeoutMs: 30 });

  assert.equal(tentouConectar, true);
  assert.equal(socket.emissions.length, 1);
  socket.emissions[0].callback({ ok: true, rooms: [] });
  assert.deepEqual(await pendente, { ok: true, rooms: [] });
});
