import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDirectCall } from '../src/useDirectCall.mjs';

const caller = { id: 1, nome: 'Órion' }, callee = { id: 2, nome: 'Vega' };
const ringing = { id: 'ring-1', status: 'ringing', caller, callee };
let renderer, current, restore, replaceSocket;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null; current = null; replaceSocket = null;
  restore?.(); restore = null;
});

function environment({ suspended = false, blocked = false, sinkRejected = false, deferredResume = false, deferredSink = false, volume = 100 } = {}) {
  const original = Object.fromEntries(['AudioContext', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const contexts = [], listeners = new Map(), output = { foneId: 'headset', volumeSaida: volume };
  const document = {
    hidden: false,
    addEventListener(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); },
    removeEventListener(event, handler) { listeners.get(event)?.delete(handler); },
  };
  class AudioContext {
    constructor() { this.state = suspended ? 'suspended' : 'running'; this.currentTime = 0; this.destination = {}; this.nodes = []; this.sinks = []; this.sinkId = ''; contexts.push(this); }
    resume() {
      this.resumes = (this.resumes || 0) + 1;
      if (blocked) return Promise.reject(new Error('Gesture required'));
      if (deferredResume) return new Promise(resolve => { this.finishResume = () => { this.state = 'running'; resolve(); }; });
      this.state = 'running'; return Promise.resolve();
    }
    setSinkId(id) {
      this.sinks.push(id);
      if (deferredSink) return new Promise((resolve, reject) => {
        const finish = () => { this.sinkId = id; resolve(); };
        finish.reject = reject; (this.finishSinks ||= []).push(finish);
      });
      if (sinkRejected && id) return Promise.reject(new Error('Device unavailable'));
      this.sinkId = id; return Promise.resolve();
    }
    close() { this.state = 'closed'; this.closed = true; return Promise.resolve(); }
    createOscillator() {
      const node = { frequency: { setValueAtTime(value) { node.hz = value; } }, connect() {}, disconnect() { node.disconnected = true; }, start() { node.started = true; }, stop(when) { if (when === undefined) node.stopped = true; } };
      this.nodes.push(node); return node;
    }
    createGain() { const changes = []; return { gain: { changes, setValueAtTime(value) { changes.push(value); }, linearRampToValueAtTime(value) { changes.push(value); }, exponentialRampToValueAtTime(value) { changes.push(value); } }, connect() {}, disconnect() {} }; }
  }
  const values = { AudioContext, document, localStorage: { getItem: () => JSON.stringify(output) } };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => { for (const [key, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  return { contexts, listeners, document, output, allow: () => { blocked = false; }, gesture: (type = 'pointerdown') => { for (const handler of listeners.get(type) || []) handler(); } };
}
function transport() {
  const handlers = new Map();
  return {
    connected: true, sent: [],
    on(event, handler) { handlers.set(event, handler); }, off(event) { handlers.delete(event); },
    receive(event, data) { handlers.get(event)?.(data); },
    emit(event, data, ack) { this.sent.push({ event, data, ack }); },
  };
}
function mount(usuarioId = 1) {
  const socket = transport();
  function Probe({ transport }) { current = useDirectCall({ socket: transport, usuarioId }); return null; }
  act(() => { renderer = TestRenderer.create(React.createElement(Probe, { transport: socket })); });
  replaceSocket = next => act(() => renderer.update(React.createElement(Probe, { transport: next })));
  return socket;
}
const flush = async callback => { await act(async () => { callback?.(); }); };
const nodes = env => env.contexts.flatMap(context => context.nodes);

test('a visible incoming private call rings repeatedly and duplicate packets do not layer loops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = environment(), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.ok(nodes(env).some(node => node.started), 'a real incoming call must schedule audible tones even with the window visible');
  assert.ok(nodes(env).every(node => node.hz >= 600), 'incoming invitation has the higher, distinct cadence');
  const initialCount = nodes(env).length;
  await flush(() => socket.receive('chamada:estado', { call: ringing }));
  assert.equal(nodes(env).length, initialCount);
  await flush(() => t.mock.timers.tick(3000));
  assert.ok(nodes(env).length > initialCount, 'ringing repeats while the invitation is pending');
  await flush(() => socket.receive('chamada:estado', { call: { ...ringing, status: 'active' } }));
  assert.ok(nodes(env).every(node => node.stopped && node.disconnected));
  const finalCount = nodes(env).length;
  await flush(() => t.mock.timers.tick(15000));
  assert.equal(nodes(env).length, finalCount, 'acceptance cancels the repeat timer');
});

test('outgoing invitations provide a lower ringback and local cancellation silences it immediately', async () => {
  const env = environment(), socket = mount();
  let request;
  act(() => { request = current.start(callee); });
  await flush(() => socket.sent[0].ack({ ok: true, call: ringing })); await request;
  assert.ok(nodes(env).length > 0);
  assert.ok(nodes(env).every(node => node.hz < 600));
  assert.ok(env.contexts[0].sinks.includes('headset'), 'ringback honors the selected output');
  act(() => current.end());
  assert.ok(nodes(env).every(node => node.stopped && node.disconnected));
  await flush(() => socket.sent[1].ack({ ok: true }));
});

for (const reason of ['declined', 'cancelled', 'timeout', 'disconnected', 'answered-elsewhere', 'friendship-removed']) {
  test(`${reason} silences a pending invitation and stale packets never restart it`, async () => {
    const env = environment(), socket = mount(2);
    await flush(() => socket.receive('chamada:recebida', { call: ringing }));
    assert.ok(nodes(env).length > 0);
    act(() => socket.receive('chamada:encerrada', { callId: ringing.id, reason }));
    assert.ok(nodes(env).every(node => node.stopped && node.disconnected));
    const count = nodes(env).length;
    await flush(() => socket.receive('chamada:estado', { call: ringing }));
    assert.equal(nodes(env).length, count);
  });
}

test('accept silences immediately, duplicate ringing stays silent while pending, and a rejected accept resumes the invitation', async () => {
  const env = environment(), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.ok(nodes(env).length > 0);
  let request;
  act(() => { request = current.accept(); });
  assert.ok(nodes(env).every(node => node.stopped));
  const count = nodes(env).length;
  await flush(() => socket.receive('chamada:estado', { call: ringing }));
  assert.equal(nodes(env).length, count);
  await flush(() => socket.sent[0].ack({ ok: false, error: 'Tente novamente.' })); await request;
  assert.ok(nodes(env).length > count);
  act(() => current.end());
  assert.ok(nodes(env).every(node => node.stopped));
  await flush(() => socket.sent[1].ack({ ok: true }));
});

test('a prior user gesture unlocks incoming audio and unmount releases the context and gesture handlers', async () => {
  const env = environment({ suspended: true }), socket = mount(2);
  await flush(() => env.gesture('keydown'));
  assert.equal(env.contexts.length, 1, 'the call hook primes audio during the earlier interaction');
  assert.ok(env.contexts[0].resumes > 0);
  assert.equal(nodes(env).length, 0, 'unlocking never plays a tone without an invitation');
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.ok(nodes(env).length > 0);
  act(() => renderer.unmount()); renderer = null;
  assert.ok(nodes(env).every(node => node.stopped && node.disconnected));
  assert.equal(env.contexts[0].closed, true);
  assert.ok([...env.listeners.values()].every(handlers => handlers.size === 0));
});

test('blocked autoplay retries on a gesture but a late resume cannot play after hangup', async () => {
  const env = environment({ suspended: true, blocked: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(nodes(env).length, 0);
  env.allow();
  await flush(() => env.gesture());
  assert.ok(nodes(env).length > 0);
  act(() => socket.receive('disconnect'));
  const count = nodes(env).length;
  await flush(() => env.gesture());
  assert.equal(nodes(env).length, count);
  assert.ok(nodes(env).every(node => node.stopped));
});

test('unavailable selected output falls back to default instead of suppressing the ringtone', async () => {
  const env = environment({ sinkRejected: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.ok(nodes(env).length > 0);
  assert.deepEqual(env.contexts[0].sinks, ['headset', '']);
});

test('muting the configured output keeps the invitation silent', async () => {
  const env = environment({ volume: 0 }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(nodes(env).length, 0);
});

test('an autoplay resume resolved after remote cancellation cannot resurrect an invitation', async () => {
  const env = environment({ suspended: true, deferredResume: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(env.contexts.length, 1);
  assert.equal(nodes(env).length, 0);
  act(() => socket.receive('chamada:encerrada', { callId: ringing.id, reason: 'cancelled' }));
  await flush(() => env.contexts[0].finishResume());
  assert.equal(nodes(env).length, 0);
  await flush(() => socket.receive('chamada:recebida', { call: { ...ringing, id: 'next-call' } }));
  assert.ok(nodes(env).length > 0, 'a later invitation still rings normally');
});

test('a delayed output-device switch cannot play the cancelled call or duplicate its replacement', async () => {
  const env = environment({ deferredSink: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(env.contexts[0].finishSinks.length, 1);
  act(() => socket.receive('chamada:encerrada', { callId: ringing.id, reason: 'cancelled' }));
  env.output.foneId = 'new-headset';
  await flush(() => socket.receive('chamada:recebida', { call: { ...ringing, id: 'next-call' } }));
  assert.equal(env.contexts[0].finishSinks.length, 1, 'output changes are serialized so the obsolete switch cannot finish after the new one');
  await flush(() => env.contexts[0].finishSinks[0]());
  assert.equal(nodes(env).length, 0, 'old routing resolution must not start an obsolete cadence');
  assert.equal(env.contexts[0].finishSinks.length, 2);
  await flush(() => env.contexts[0].finishSinks[1]());
  assert.equal(nodes(env).length, 4, 'replacement invitation plays only its own cadence');
  assert.equal(env.contexts[0].sinkId, 'new-headset');
});

test('a removed output from a cancelled call cannot reset the replacement call to the default device', async () => {
  const env = environment({ deferredSink: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  act(() => socket.receive('chamada:encerrada', { callId: ringing.id, reason: 'cancelled' }));
  env.output.foneId = 'new-headset';
  await flush(() => socket.receive('chamada:recebida', { call: { ...ringing, id: 'next-call' } }));
  await flush(() => env.contexts[0].finishSinks[0].reject(new Error('Old headset removed.')));
  assert.deepEqual(env.contexts[0].sinks, ['headset', 'new-headset'], 'the obsolete failure must not request a default-output fallback');
  await flush(() => env.contexts[0].finishSinks[1]());
  assert.equal(env.contexts[0].sinkId, 'new-headset');
  assert.ok(nodes(env).length > 0);
});

test('unmount during output-device selection closes audio and ignores the later routing completion', async () => {
  const env = environment({ deferredSink: true }), socket = mount(2);
  await flush(() => socket.receive('chamada:recebida', { call: ringing }));
  assert.equal(env.contexts[0].finishSinks.length, 1);
  act(() => renderer.unmount()); renderer = null;
  assert.equal(env.contexts[0].closed, true);
  await flush(() => env.contexts[0].finishSinks[0]());
  assert.equal(nodes(env).length, 0);
});

test('an accept acknowledgment from a replaced socket cannot restart audio during the new pending accept', async () => {
  const env = environment(), originalSocket = mount(2);
  await flush(() => originalSocket.receive('chamada:recebida', { call: ringing }));
  let originalAccept;
  act(() => { originalAccept = current.accept(); });
  const replacementSocket = transport();
  replaceSocket(replacementSocket);
  await flush(() => replacementSocket.receive('chamada:recebida', { call: ringing }));
  let replacementAccept;
  act(() => { replacementAccept = current.accept(); });
  assert.ok(nodes(env).every(node => node.stopped));
  const count = nodes(env).length;
  await flush(() => originalSocket.sent[0].ack({ ok: false, error: 'Resposta antiga.' })); await originalAccept;
  assert.equal(current.pending, true);
  assert.equal(nodes(env).length, count, 'the old accept cannot unmute the new pending accept of the same call');
  await flush(() => replacementSocket.sent[0].ack({ ok: true, call: { ...ringing, status: 'active' } })); await replacementAccept;
  assert.equal(current.call.status, 'active');
  assert.equal(nodes(env).length, count);
});
