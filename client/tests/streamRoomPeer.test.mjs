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
    this.offerCalls = 0;
    this.answerCalls = 0;
    FakePeerConnection.instances.push(this);
  }
  addTrack(track, stream) { const sender = { track, stream, params: { encodings: [{}] }, getParameters() { return this.params; }, setParameters: async (params) => { sender.params = params; } }; this.senders.push(sender); return sender; }
  getSenders() { return this.senders; }
  async createOffer() { this.offerCalls += 1; return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { this.answerCalls += 1; return { type: 'answer', sdp: 'answer-sdp' }; }
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

test('stream peer: default high-quality profile applies a 16 Mbps ceiling to each sender', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakePeerConnection.instances[0].senders[0].params.encodings[0].maxBitrate, 16_000_000);
  session.close();
});

test('stream peer: a newly elected presenter offers the existing room participants', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a', 'viewer-b']);
  await new Promise((resolve) => setImmediate(resolve));
  const offers = socket.sent.filter(({ event }) => event === 'sala:sinal:oferta');
  assert.deepEqual(offers.map(({ payload }) => payload.para).sort(), ['viewer-a', 'viewer-b']);
  assert.equal(session.getPeerCount(), 2);
  session.resetPeers();
  assert.equal(session.getPeerCount(), 0);
  assert.equal(FakePeerConnection.instances.every((peer) => peer.connectionState === 'closed'), true);
  session.close();
});

test('stream peer: readiness retries a pending offer without renegotiating', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  const offers = socket.sent.filter(({ event }) => event === 'sala:sinal:oferta');
  assert.equal(offers.length, 2, 'readiness should resend the offer in case the viewer missed it');
  assert.deepEqual(offers[0].payload.descricao, offers[1].payload.descricao);
  assert.equal(FakePeerConnection.instances[0].offerCalls, 1, 'retry should reuse the existing offer');
  session.close();
});

test('stream peer: host creates a fresh peer and offer after ICE fails', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const scheduled = [];
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    RTCPeerConnectionImpl: FakePeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback) => { scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
  });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  const failedPeer = FakePeerConnection.instances[0];
  failedPeer.connectionState = 'failed';
  failedPeer.onconnectionstatechange();
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[0].connectionState, 'closed');
  assert.equal(socket.sent.filter(({ event }) => event === 'sala:sinal:oferta').length, 2);
  assert.equal(session.getPeerCount(), 1);
  session.close();
});

test('stream peer: viewer requests a new offer after its ICE connection fails', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const scheduled = [];
  const failedPeers = [];
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'viewer',
    onPeerConnectionFailed: (peerId) => failedPeers.push(peerId),
    RTCPeerConnectionImpl: FakePeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback) => { scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
  });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' } });
  await new Promise((resolve) => setImmediate(resolve));
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  scheduled.shift()();

  assert.equal(peer.connectionState, 'closed');
  assert.deepEqual(failedPeers, ['host-a']);
  assert.equal(session.getPeerCount(), 0);
  session.close();
});

test('stream peer: brief ICE disconnection that recovers cancels peer replacement', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const scheduled = [];
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'viewer',
    RTCPeerConnectionImpl: FakePeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback) => { scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
  });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' } });
  await new Promise((resolve) => setImmediate(resolve));
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  scheduled.forEach((retry) => retry());

  assert.equal(session.getPeerCount(), 1);
  assert.equal(peer.connectionState, 'connected');
  assert.equal(scheduled.length, 0);
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

test('stream peer: repeated offer retries resend the cached answer', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', RTCPeerConnectionImpl: FakePeerConnection });
  const offer = { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' } };
  socket.receive('sala:sinal:oferta', offer);
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive('sala:sinal:oferta', offer);
  await new Promise((resolve) => setImmediate(resolve));
  const answers = socket.sent.filter(({ event }) => event === 'sala:sinal:resposta');
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0].payload.resposta, answers[1].payload.resposta);
  assert.equal(FakePeerConnection.instances[0].answerCalls, 1);
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

test('stream peer: leaving before screen capture does not retain a stale viewer', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-gone' });
  socket.receive('sala:espectador-saiu', { salaId: 'room-1', socketId: 'viewer-gone' });
  session.setLocalStream(makeStream());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.getPeerCount(), 0);
  assert.equal(socket.sent.some(({ event }) => event === 'sala:sinal:oferta'), false);
  session.close();
});

test('stream peer: reports when the browser rejects the requested bitrate', async () => {
  class RejectingBitratePeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      sender.setParameters = async () => { throw new Error('unsupported bitrate'); };
      return sender;
    }
  }
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const qualityErrors = [];
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    onQualityError: (error) => qualityErrors.push(error),
    RTCPeerConnectionImpl: RejectingBitratePeerConnection,
  });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(qualityErrors.length, 1);
  assert.match(qualityErrors[0].message, /unsupported bitrate/);
  session.close();
});
