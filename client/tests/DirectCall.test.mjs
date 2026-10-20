import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { requestDirectCall, useDirectCall } from '../src/useDirectCall.mjs';

let renderer, current;
const caller = { id: 1, nome: 'Órion' }, callee = { id: 2, nome: 'Vega' };
const ringing = { id: 'call-1', canalId: 'direta:call-1', status: 'ringing', caller, callee };
const active = { ...ringing, status: 'active' };
function transport() {
  const handlers = new Map();
  return {
    connected: true, sent: [],
    on(event, handler) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
    off(event, handler) { handlers.get(event)?.delete(handler); },
    emit(event, data, ack) { this.sent.push({ event, data, ack }); },
    receive(event, data) { for (const fn of handlers.get(event) || []) fn(data); },
  };
}
function mount(socket, options = {}) {
  const events = { active: [], ended: [] };
  function Probe() {
    current = useDirectCall({ socket, usuarioId: options.usuarioId || 1, onActive: call => events.active.push(call), onEnded: id => events.ended.push(id) });
    return null;
  }
  act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
  return events;
}
afterEach(() => { act(() => renderer?.unmount()); renderer = null; current = null; });

test('outgoing invitation never opens media until acceptance and duplicate clicks send once', async () => {
  const socket = transport(), events = mount(socket);
  let promise;
  act(() => { promise = current.start(callee); void current.start(callee); });
  assert.equal(socket.sent.length, 1);
  act(() => socket.receive('chamada:estado', { call: ringing }));
  assert.equal(current.call.status, 'ringing');
  assert.equal(events.active.length, 0);
  act(() => socket.receive('chamada:estado', { call: active }));
  await act(async () => { socket.sent[0].ack({ ok: true, call: ringing }); await promise; });
  assert.equal(current.call.status, 'active', 'late ringing acknowledgment cannot regress an active call');
  assert.equal(events.active.length, 1);
  act(() => socket.receive('chamada:estado', { call: active }));
  assert.equal(events.active.length, 1, 'duplicate server state must not remount media');
});

test('incoming invite accepts explicitly and ending immediately tears down media', async () => {
  const socket = transport(), events = mount(socket, { usuarioId: 2 });
  act(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(current.incoming, true);
  assert.equal(events.active.length, 0);
  let promise;
  act(() => { promise = current.accept(); });
  assert.equal(socket.sent[0].event, 'chamada:aceitar');
  await act(async () => { socket.sent[0].ack({ ok: true, call: active }); await promise; });
  assert.equal(events.active.length, 1);
  act(() => current.end());
  assert.equal(current.call, null);
  assert.deepEqual(events.ended, ['call-1']);
  assert.equal(socket.sent[1].event, 'chamada:encerrar');
  await act(async () => socket.sent[1].ack({ ok: true }));
});

test('cancellation wins against delayed start and acceptance packets', async () => {
  const socket = transport(), events = mount(socket);
  let start;
  act(() => { start = current.start(callee); });
  act(() => socket.receive('chamada:estado', { call: ringing }));
  act(() => current.end());
  assert.equal(socket.sent[1].event, 'chamada:cancelar');
  await act(async () => {
    socket.sent[1].ack({ ok: true });
    socket.sent[0].ack({ ok: true, call: ringing });
    socket.receive('chamada:estado', { call: active });
    await start;
  });
  assert.equal(current.call, null);
  assert.equal(current.pending, false);
  assert.equal(events.active.length, 0);
});

test('remote hangup and transport loss clear active call once and explain disconnect', () => {
  const socket = transport(), events = mount(socket);
  act(() => socket.receive('chamada:estado', { call: active }));
  act(() => { socket.connected = false; socket.receive('disconnect'); });
  assert.equal(current.call, null);
  assert.match(current.error, /conexão foi interrompida/);
  act(() => socket.receive('chamada:encerrada', { callId: active.id, reason: 'disconnected' }));
  assert.equal(events.ended.length, 1);
});

test('timeout, decline and answer in another tab dismiss ringing without starting media', () => {
  const socket = transport(), events = mount(socket, { usuarioId: 2 });
  for (const reason of ['declined', 'timeout', 'answered-elsewhere']) {
    const call = { ...ringing, id: reason };
    act(() => socket.receive('chamada:recebida', { call }));
    act(() => socket.receive('chamada:encerrada', { callId: call.id, reason }));
    assert.equal(current.call, null);
    assert.ok(current.error);
  }
  assert.equal(events.active.length, 0);
});

test('offline and server busy failures do not leave ringing state or pending controls', async () => {
  const socket = transport();
  mount(socket);
  socket.connected = false;
  await act(async () => current.start(callee));
  assert.equal(socket.sent.length, 0);
  assert.match(current.error, /Conecte-se/);
  socket.connected = true;
  let promise;
  act(() => { promise = current.start(callee); });
  await act(async () => { socket.sent[0].ack({ ok: false, error: 'Seu amigo está ocupado.' }); await promise; });
  assert.equal(current.pending, false);
  assert.equal(current.call, null);
  assert.match(current.error, /ocupado/);
});

test('unmounted client ignores late acknowledgement and removes event handlers', async () => {
  const socket = transport(), events = mount(socket);
  let promise;
  act(() => { promise = current.start(callee); });
  act(() => renderer.unmount());
  await act(async () => {
    socket.sent[0].ack({ ok: true, call: active });
    socket.receive('chamada:estado', { call: active });
    await promise;
  });
  assert.equal(events.active.length, 0);
});

test('request timeout rejects instead of waiting indefinitely or buffering offline operations', async () => {
  await assert.rejects(requestDirectCall(transport(), 'chamada:iniciar', { paraUsuarioId: 2 }, 5), /demorou/);
  await assert.rejects(requestDirectCall({ connected: false }, 'chamada:iniciar', {}), /Conecte-se/);
});
