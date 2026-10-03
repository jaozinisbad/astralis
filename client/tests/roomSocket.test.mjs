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
