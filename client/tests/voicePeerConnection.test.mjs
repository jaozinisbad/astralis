import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoicePeerConnection } from '../src/voicePeerConnection.mjs';

function fixture({ polite = true } = {}) {
  const timers = new Map();
  const emitted = [];
  const updates = [];
  const candidates = [];
  const peer = new EventTarget();
  Object.assign(peer, {
    connectionState: 'new', signalingState: 'stable',
    async createOffer(options) { return { type: 'offer', sdp: options?.iceRestart ? 'restart' : 'offer' }; },
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; },
    async setLocalDescription(description) { this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; },
    async setRemoteDescription(description) {
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
      this.remoteDescription = description;
    },
    async addIceCandidate(candidate) { candidates.push(candidate); },
  });
  const call = createVoicePeerConnection({
    peer, polite,
    prepare: async () => {},
    emit: (event, field, description) => emitted.push({ event, field, description }),
    onStatus: (status) => updates.push(status),
    setTimer: (run, delay) => { const key = Symbol(); timers.set(key, { run, delay }); return key; },
    clearTimer: (key) => timers.delete(key),
  });
  return { call, peer, timers, emitted, candidates, updates };
}

test('keeps early and restarted candidates until the matching remote ICE description', async () => {
  const { call, peer, emitted, candidates, timers } = fixture();
  const initial = { usernameFragment: 'first' };
  const restarted = { usernameFragment: 'next' };
  await call.receiveCandidate(initial);
  await call.receiveOffer({ type: 'offer', sdp: 'a=ice-ufrag:first\r\n', idOferta: 1 });
  assert.deepEqual(candidates, [initial]);
  assert.equal(emitted[0].description.idOferta, 1);
  await call.receiveCandidate(restarted);
  assert.deepEqual(candidates, [initial]);
  await call.receiveOffer({ type: 'offer', sdp: 'a=ice-ufrag:next\r\n', idOferta: 2 });
  assert.deepEqual(candidates, [initial, restarted]);
  assert.equal(peer.signalingState, 'stable');
  call.close();
  assert.equal(timers.size, 0);
});

test('debounces an ICE loss, restarts media and ignores a late answer to the previous offer', async () => {
  const { call, peer, updates, emitted, timers } = fixture();
  await call.offer();
  await call.receiveAnswer({ type: 'answer', sdp: 'initial', idOferta: 1 }, (value) => value);
  peer.connectionState = 'connected';
  peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(timers.size, 0);
  peer.connectionState = 'disconnected';
  peer.dispatchEvent(new Event('connectionstatechange'));
  const [key, timer] = [...timers.entries()][0];
  assert.equal(timer.delay, 2500);
  timers.delete(key);
  timer.run();
  await call.receiveAnswer({ type: 'answer', sdp: 'stale', idOferta: 1 }, (value) => value);
  assert.equal(emitted.at(-1).description.sdp, 'restart');
  assert.equal(peer.remoteDescription.sdp, 'initial');
  await call.receiveAnswer({ type: 'answer', sdp: 'fresh', idOferta: 2 }, (value) => value);
  peer.connectionState = 'connected';
  peer.dispatchEvent(new Event('connectionstatechange'));
  assert.deepEqual(updates, ['connected', 'reconnecting', 'connected']);
  assert.equal(peer.remoteDescription.sdp, 'fresh');
  assert.equal(timers.size, 0);
  call.close();
});
