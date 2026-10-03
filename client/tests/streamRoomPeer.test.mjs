import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamRoomPeerSession } from '../src/streamRoomPeer.mjs';

class FakeSocket {
  listeners = new Map();
  sent = [];
  on(event, listener) { this.listeners.set(event, listener); }
  off(event, listener) { if (this.listeners.get(event) === listener) this.listeners.delete(event); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  receive(event, payload) { this.listeners.get(event)?.(payload); }
}

class FakePeerConnection {
  static instances = [];
  constructor() {
    this.senders = [];
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.connectionState = 'new';
    FakePeerConnection.instances.push(this);
  }
  addTrack(track, stream) { const sender = { track, stream, params: { encodings: [{}] }, getParameters() { return this.params; }, setParameters: async (params) => { sender.params = params; } }; this.senders.push(sender); return sender; }
  getSenders() { return this.senders; }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.addedCandidates.push(value); }
  close() { this.connectionState = 'closed'; }
}

function makeStream() {
  return { getTracks: () => [{ kind: 'video', id: 'screen-track' }] };
}

test('stream peer: host creates offers only for viewers in its room', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', quality: { bitrate: 8_000_000, adaptiveQuality: true }, RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-2', socketId: 'wrong-room' });
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  const offers = socket.sent.filter(({ event }) => event === 'sala:sinal:oferta');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].payload.para, 'viewer-a');
  assert.equal(offers[0].payload.descricao.sdp, 'offer-sdp');
  assert.equal(FakePeerConnection.instances[0].senders[0].params.encodings[0].maxBitrate, 8_000_000);
  session.close();
});

test('stream peer: viewers answer offers and apply ICE candidates received early', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const remoteStream = { id: 'remote-screen' };
  let shown = null;
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', onRemoteStream: (_peerId, stream) => { shown = stream; }, RTCPeerConnectionImpl: FakePeerConnection });
  socket.receive('sala:sinal:candidato', { roomId: 'room-1', de: 'host-a', candidato: { candidate: 'early' } });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(FakePeerConnection.instances[0].addedCandidates, [{ candidate: 'early' }]);
  assert.ok(socket.sent.some(({ event, payload }) => event === 'sala:sinal:resposta' && payload.para === 'host-a' && payload.resposta.sdp === 'answer-sdp'));
  FakePeerConnection.instances[0].ontrack({ streams: [remoteStream] });
  assert.equal(shown, remoteStream);
  session.close();
});

test('stream peer: closes peers and removes socket listeners', () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', RTCPeerConnectionImpl: FakePeerConnection });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' } });
  session.close();
  assert.equal(FakePeerConnection.instances[0].connectionState, 'closed');
  assert.equal(socket.listeners.size, 0);
});

test('stream peer: viewers remain available when the host stops and restarts screen sharing', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  session.setLocalStream(null);
  session.setLocalStream(makeStream());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter(({ event }) => event === 'sala:sinal:oferta').length, 2);
  session.close();
});
