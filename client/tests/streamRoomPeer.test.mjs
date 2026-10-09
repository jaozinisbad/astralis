import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamRoomPeerSession } from '../src/streamRoomPeer.mjs';

class FakeSocket {
  listeners = new Map();
  sent = [];
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
  }
  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
    if (this.listeners.get(event)?.size === 0) this.listeners.delete(event);
  }
  emit(event, payload) { this.sent.push({ event, payload }); }
  receive(event, payload) { this.listeners.get(event)?.forEach((listener) => listener(payload)); }
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

class FakeTimers {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  };

  clearTimeout = (id) => { this.tasks.delete(id); };

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.due;
      task.callback();
    }
    this.now = target;
  }
}

const flushPeerTasks = () => new Promise((resolve) => setImmediate(resolve));

test('stream peer: two viewer sessions on one socket keep offers, ICE, and remote streams separate', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const remote = [];
  const viewerA = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', streamId: 'host-a', onRemoteStream: (peerId, stream) => remote.push(['a', peerId, stream]), RTCPeerConnectionImpl: FakePeerConnection });
  const viewerB = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', streamId: 'host-b', onRemoteStream: (peerId, stream) => remote.push(['b', peerId, stream]), RTCPeerConnectionImpl: FakePeerConnection });

  socket.receive('sala:sinal:candidato', { roomId: 'room-1', streamId: 'host-b', de: 'host-b', candidato: { candidate: 'b-early' } });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', streamId: 'host-a', de: 'host-a', descricao: { type: 'offer', sdp: 'a-offer' } });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', streamId: 'host-b', de: 'host-b', descricao: { type: 'offer', sdp: 'b-offer' } });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', streamId: 'host-a', de: 'host-b', descricao: { type: 'offer', sdp: 'wrong-broadcast' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewerA.getPeerCount(), 1);
  assert.equal(viewerB.getPeerCount(), 1);
  assert.deepEqual(FakePeerConnection.instances.map((peer) => peer.remoteDescription?.sdp).sort(), ['a-offer', 'b-offer']);
  const peerA = FakePeerConnection.instances.find((peer) => peer.remoteDescription?.sdp === 'a-offer');
  const peerB = FakePeerConnection.instances.find((peer) => peer.remoteDescription?.sdp === 'b-offer');
  assert.deepEqual(peerB.addedCandidates, [{ candidate: 'b-early' }]);
  assert.deepEqual(socket.sent.filter(({ event }) => event === 'sala:sinal:resposta').map(({ payload }) => [payload.para, payload.streamId]).sort(), [['host-a', 'host-a'], ['host-b', 'host-b']]);

  const streamA = { id: 'screen-a' };
  const streamB = { id: 'screen-b' };
  peerA.ontrack({ streams: [streamA] });
  peerB.ontrack({ streams: [streamB] });
  assert.deepEqual(remote, [['a', 'host-a', streamA], ['b', 'host-b', streamB]]);

  viewerA.close();
  assert.equal(viewerB.getPeerCount(), 1);
  socket.receive('sala:sinal:candidato', { roomId: 'room-1', streamId: 'host-b', de: 'host-b', candidato: { candidate: 'b-late' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(peerB.addedCandidates, [{ candidate: 'b-early' }, { candidate: 'b-late' }]);
  viewerB.close();
  assert.equal(socket.listeners.size, 0);
});

test('stream peer: configured host isolates tagged signals and accepts old server replies', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  socket.id = 'host-a';
  const host = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', streamId: 'host-a', RTCPeerConnectionImpl: FakePeerConnection });
  host.setLocalStream(makeStream());
  await host.setViewers(['viewer-a']);
  const peer = FakePeerConnection.instances[0];

  assert.equal(socket.sent.find(({ event }) => event === 'sala:sinal:oferta').payload.streamId, 'host-a');
  peer.onicecandidate({ candidate: { candidate: 'host-ice' } });
  assert.equal(socket.sent.find(({ event }) => event === 'sala:sinal:candidato').payload.streamId, 'host-a');

  socket.receive('sala:sinal:candidato', { roomId: 'room-1', streamId: 'host-b', de: 'viewer-a', candidato: { candidate: 'wrong-ice' } });
  socket.receive('sala:sinal:resposta', { roomId: 'room-1', streamId: 'host-b', de: 'viewer-a', resposta: { type: 'answer', sdp: 'wrong-answer' } });
  socket.receive('sala:sinal:candidato', { roomId: 'room-1', de: 'viewer-a', candidato: { candidate: 'legacy-ice' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.remoteDescription, null);
  assert.deepEqual(peer.addedCandidates, []);

  socket.receive('sala:sinal:candidato', { roomId: 'room-1', streamId: 'host-a', de: 'viewer-a', candidato: { candidate: 'host-a-ice' } });
  socket.receive('sala:sinal:resposta', { roomId: 'room-1', de: 'viewer-a', resposta: { type: 'answer', sdp: 'host-a-answer' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.remoteDescription.sdp, 'host-a-answer');
  assert.deepEqual(peer.addedCandidates, [{ candidate: 'legacy-ice' }, { candidate: 'host-a-ice' }]);
  host.close();
});

test('stream peer: configured viewer accepts untagged offer only from its presenter', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const viewer = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', streamId: 'host-a', RTCPeerConnectionImpl: FakePeerConnection });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-b', descricao: { type: 'offer', sdp: 'wrong' } });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'legacy' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.getPeerCount(), 1);
  assert.equal(FakePeerConnection.instances[0].remoteDescription.sdp, 'legacy');
  assert.equal(socket.sent.find(({ event }) => event === 'sala:sinal:resposta').payload.streamId, 'host-a');
  viewer.close();
});

test('stream peer: unconfigured legacy session accepts only untagged signals', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const legacy = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'viewer', RTCPeerConnectionImpl: FakePeerConnection });
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', streamId: 'host-a', de: 'host-a', descricao: { type: 'offer', sdp: 'tagged' } });
  assert.equal(legacy.getPeerCount(), 0);
  socket.receive('sala:sinal:oferta', { roomId: 'room-1', de: 'host-a', descricao: { type: 'offer', sdp: 'legacy' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakePeerConnection.instances[0].remoteDescription.sdp, 'legacy');
  assert.equal(Object.hasOwn(socket.sent.find(({ event }) => event === 'sala:sinal:resposta').payload, 'streamId'), false);
  legacy.close();
});

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

test('stream peer: default profile applies a 4 Mbps ceiling to each sender', async () => {
  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  const session = createStreamRoomPeerSession({ socket, roomId: 'room-1', role: 'host', RTCPeerConnectionImpl: FakePeerConnection });
  session.setLocalStream(makeStream());
  socket.receive('sala:espectador-entrou', { salaId: 'room-1', socketId: 'viewer-a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakePeerConnection.instances[0].senders[0].params.encodings[0].maxBitrate, 4_000_000);
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
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
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
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
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
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
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
  assert.ok(qualityErrors.length >= 1);
  assert.match(qualityErrors[0].message, /unsupported bitrate/);
  session.close();
});

test('stream peer: WebRTC stats publish measured media metrics and reallocate the aggregate bitrate budget', async () => {
  class StatsPeerConnection extends FakePeerConnection {
    async getStats() {
      return new Map((this.statsReports || []).map((report) => [report.id, report]));
    }
  }
  const statsFor = (peerId, availableOutgoingBitrate, reason = 'none') => [
    {
      id: `outbound-${peerId}`,
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1_000,
      bytesSent: 20_000,
      framesEncoded: 30,
      frameWidth: 1280,
      frameHeight: 720,
      qualityLimitationReason: reason,
      transportId: `transport-${peerId}`,
    },
    { id: `transport-${peerId}`, type: 'transport', selectedCandidatePairId: `pair-${peerId}` },
    {
      id: `pair-${peerId}`,
      type: 'candidate-pair',
      state: 'succeeded',
      selected: true,
      currentRoundTripTime: 0.07,
      availableOutgoingBitrate,
    },
  ];

  FakePeerConnection.instances = [];
  const socket = new FakeSocket();
  let scheduledStats;
  let clearedStats;
  let diagnostics;
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    onStats: (value) => { diagnostics = value; },
    RTCPeerConnectionImpl: StatsPeerConnection,
    setIntervalImpl: (callback) => { scheduledStats = callback; return { id: 'stats-timer' }; },
    clearIntervalImpl: (timer) => { clearedStats = timer; },
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-weak', 'viewer-strong']);
  const [weak, strong] = FakePeerConnection.instances;
  weak.connectionState = 'connected';
  strong.connectionState = 'connected';
  weak.statsReports = statsFor('weak', 1_000_000, 'bandwidth');
  strong.statsReports = statsFor('strong', 8_000_000, 'bandwidth');

  await session.refreshStats();
  await session.refreshStats();

  assert.equal(typeof scheduledStats, 'function');
  assert.equal(diagnostics.role, 'host');
  assert.equal(diagnostics.videoBudget, 4_000_000);
  assert.equal(diagnostics.peers.find((peer) => peer.peerId === 'viewer-weak').metrics.frameWidth, 1280);
  assert.equal(diagnostics.peers.find((peer) => peer.peerId === 'viewer-weak').metrics.roundTripTimeSeconds, 0.07);
  assert.equal(diagnostics.peers.find((peer) => peer.peerId === 'viewer-weak').targetVideoBitrate, 850_000);
  assert.equal(diagnostics.peers.find((peer) => peer.peerId === 'viewer-strong').targetVideoBitrate, 3_150_000);
  assert.ok(diagnostics.peers.reduce((sum, peer) => sum + peer.targetVideoBitrate, 0) <= diagnostics.videoBudget);

  session.close();
  assert.deepEqual(clearedStats, { id: 'stats-timer' });
});

test('stream peer: ignores a cold start BWE and rising estimates instead of collapsing quality', async () => {
  class ColdStartStatsPeer extends FakePeerConnection {
    async getStats() { return new Map((this.statsReports || []).map((report) => [report.id, report])); }
  }
  const reports = (availableOutgoingBitrate, qualityLimitationReason, timestamp) => [
    { id: 'outbound', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: timestamp * 100, framesEncoded: timestamp, qualityLimitationReason, transportId: 'transport' },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.001, availableOutgoingBitrate },
  ];

  FakePeerConnection.instances = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(), roomId: 'room-1', role: 'host', streamId: 'host-a',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    RTCPeerConnectionImpl: ColdStartStatsPeer, setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a']);
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'connected';

  for (const [estimate, reason, timestamp] of [
    [300_000, 'none', 1_000],
    [1_500_000, 'bandwidth', 2_000],
    [2_500_000, 'bandwidth', 3_000],
    [3_300_000, 'bandwidth', 4_000],
  ]) {
    peer.statsReports = reports(estimate, reason, timestamp);
    await session.refreshStats();
    assert.equal(peer.senders[0].params.encodings[0].maxBitrate, 4_000_000);
  }
  session.close();
});

test('stream peer: reduces only after two stable bandwidth-limited estimates', async () => {
  class CongestedStatsPeer extends FakePeerConnection {
    async getStats() { return new Map((this.statsReports || []).map((report) => [report.id, report])); }
  }
  const reports = (timestamp) => [
    { id: 'outbound', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: timestamp * 100, framesEncoded: timestamp, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth', transportId: 'transport' },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.08, availableOutgoingBitrate: 500_000 },
  ];

  FakePeerConnection.instances = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(), roomId: 'room-1', role: 'host', streamId: 'host-a',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    RTCPeerConnectionImpl: CongestedStatsPeer, setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a']);
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'connected';
  peer.statsReports = reports(1_000);
  await session.refreshStats();
  assert.equal(peer.senders[0].params.encodings[0].maxBitrate, 4_000_000);
  peer.statsReports = reports(2_000);
  await session.refreshStats();
  assert.equal(peer.senders[0].params.encodings[0].maxBitrate, 425_000);
  session.close();
});
test('stream peer: serializes bitrate updates and applies a preference change when the cap is unchanged', async () => {
  class DelayedPeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      let activeWrites = 0;
      sender.maxConcurrentWrites = 0;
      const apply = sender.setParameters;
      sender.setParameters = async (parameters) => {
        activeWrites += 1;
        sender.maxConcurrentWrites = Math.max(sender.maxConcurrentWrites, activeWrites);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await apply(parameters);
        } finally {
          activeWrites -= 1;
        }
      };
      return sender;
    }
  }

  FakePeerConnection.instances = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(),
    roomId: 'room-1',
    role: 'host',
    RTCPeerConnectionImpl: DelayedPeerConnection,
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a']);
  const sender = FakePeerConnection.instances[0].senders[0];

  await session.setQuality({ bitrate: 4_000_000, adaptiveQuality: false, contentType: 'detail' });
  assert.equal(sender.params.encodings[0].maxBitrate, 4_000_000);
  assert.equal(sender.params.degradationPreference, 'maintain-resolution');

  const reduce = session.setQuality({ bitrate: 2_000_000, adaptiveQuality: true, contentType: 'detail' });
  const raise = session.setQuality({ bitrate: 8_000_000, adaptiveQuality: true, contentType: 'motion' });
  await Promise.all([reduce, raise]);

  assert.equal(sender.params.encodings[0].maxBitrate, 8_000_000);
  assert.equal(sender.params.degradationPreference, 'maintain-framerate');
  assert.equal(sender.maxConcurrentWrites, 1);
  session.close();
});

test('stream peer: a failed reduction does not transfer its bitrate share to another viewer', async () => {
  class FailingPeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      sender.rejectParameters = false;
      sender.getParameters = () => ({
        ...sender.params,
        encodings: sender.params.encodings.map((encoding) => ({ ...encoding })),
      });
      const apply = sender.setParameters;
      sender.setParameters = async (parameters) => {
        if (sender.rejectParameters) {
          throw new Error('setParameters rejeitado');
        }
        return apply(parameters);
      };
      return sender;
    }
    async getStats() {
      return new Map((this.statsReports || []).map((report) => [report.id, report]));
    }
  }
  const reports = (peerId, availableOutgoingBitrate) => [
    {
      id: `outbound-${peerId}`, type: 'outbound-rtp', kind: 'video',
      timestamp: 1_000, bytesSent: 10_000, framesEncoded: 30,
      frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth',
      transportId: `transport-${peerId}`,
    },
    { id: `transport-${peerId}`, type: 'transport', selectedCandidatePairId: `pair-${peerId}` },
    {
      id: `pair-${peerId}`, type: 'candidate-pair', state: 'succeeded',
      selected: true, currentRoundTripTime: 0.08, availableOutgoingBitrate,
    },
  ];

  FakePeerConnection.instances = [];
  const qualityErrors = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(),
    roomId: 'room-1',
    role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    onQualityError: (error) => qualityErrors.push(error),
    RTCPeerConnectionImpl: FailingPeerConnection,
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-weak', 'viewer-strong']);
  const [weak, strong] = FakePeerConnection.instances;
  weak.connectionState = 'connected';
  strong.connectionState = 'connected';
  weak.senders[0].rejectParameters = true;
  weak.statsReports = reports('weak', 500_000);
  strong.statsReports = reports('strong', 8_000_000);

  await session.refreshStats();
  await session.refreshStats();

  assert.equal(weak.senders[0].params.encodings[0].maxBitrate, 2_000_000);
  assert.equal(strong.senders[0].params.encodings[0].maxBitrate, 2_000_000);
  assert.ok(qualityErrors.length >= 1);
  session.close();
});

test('stream peer: accepts low bandwidth estimates and expires a missing estimate', async () => {
  class ExpiringStatsPeerConnection extends FakePeerConnection {
    async getStats() {
      return new Map((this.statsReports || []).map((report) => [report.id, report]));
    }
  }
  const reports = (peerId, availableOutgoingBitrate) => [
    {
      id: `outbound-${peerId}`, type: 'outbound-rtp', kind: 'video',
      timestamp: 1_000, bytesSent: 10_000, framesEncoded: 30,
      frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth',
      transportId: `transport-${peerId}`,
    },
    { id: `transport-${peerId}`, type: 'transport', selectedCandidatePairId: `pair-${peerId}` },
    {
      id: `pair-${peerId}`, type: 'candidate-pair', state: 'succeeded',
      selected: true, currentRoundTripTime: 0.08,
      ...(availableOutgoingBitrate === undefined ? {} : { availableOutgoingBitrate }),
    },
  ];

  FakePeerConnection.instances = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(),
    roomId: 'room-1',
    role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    statsEstimateTtlMs: 15,
    RTCPeerConnectionImpl: ExpiringStatsPeerConnection,
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-weak', 'viewer-strong']);
  const [weak, strong] = FakePeerConnection.instances;
  weak.connectionState = 'connected';
  strong.connectionState = 'connected';
  weak.statsReports = reports('weak', 100_000);
  strong.statsReports = reports('strong', 8_000_000);

  await session.refreshStats();
  await session.refreshStats();
  assert.equal(weak.senders[0].params.encodings[0].maxBitrate, 85_000);
  assert.equal(strong.senders[0].params.encodings[0].maxBitrate, 3_915_000);

  await new Promise((resolve) => setTimeout(resolve, 25));
  weak.statsReports = reports('weak');
  await session.refreshStats();

  assert.equal(weak.senders[0].params.encodings[0].maxBitrate, 2_000_000);
  assert.equal(strong.senders[0].params.encodings[0].maxBitrate, 2_000_000);
  assert.equal(session.getPeerCount(), 2);
  session.close();
});


test('stream peer: new viewer waits for its bitrate cap and retries before receiving an offer', async () => {
  class RetryBitratePeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      sender.rejectParameters = true;
      sender.getParameters = () => ({ ...sender.params, encodings: sender.params.encodings.map((encoding) => ({ ...encoding })) });
      const apply = sender.setParameters;
      sender.setParameters = async (parameters) => {
        if (sender.rejectParameters) throw new Error('temporarily rejected bitrate');
        return apply(parameters);
      };
      return sender;
    }
  }

  FakePeerConnection.instances = [];
  const scheduled = [];
  const session = createStreamRoomPeerSession({
    socket: new FakeSocket(),
    roomId: 'room-1',
    role: 'host',
    RTCPeerConnectionImpl: RetryBitratePeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  let joined = false;
  const pendingJoin = session.setViewers(['viewer-retry']).then(() => { joined = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const peer = FakePeerConnection.instances[0];
  assert.equal(peer.senders[0].params.encodings[0].maxBitrate, undefined);
  assert.equal(peer.offerCalls, 0, 'offer must wait until the cap is accepted');
  assert.equal(joined, false, 'joining should await the quality retry');
  assert.equal(scheduled.length, 1);

  peer.senders[0].rejectParameters = false;
  scheduled.shift()();
  await pendingJoin;
  assert.equal(peer.senders[0].params.encodings[0].maxBitrate, 4_000_000);
  assert.equal(peer.offerCalls, 1);
  session.close();
});

test('stream peer: failed bitrate initialization retries finitely, removes the viewer, and restores remaining budget', async () => {
  class RejectingNewPeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      const rejectThisSender = FakePeerConnection.instances.length > 1;
      sender.getParameters = () => ({ ...sender.params, encodings: sender.params.encodings.map((encoding) => ({ ...encoding })) });
      const apply = sender.setParameters;
      sender.setParameters = async (parameters) => {
        if (rejectThisSender) throw new Error('unsupported bitrate');
        return apply(parameters);
      };
      return sender;
    }
  }

  FakePeerConnection.instances = [];
  const scheduled = [];
  const errors = [];
  const socket = new FakeSocket();
  let diagnostics;
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    onStats: (value) => { diagnostics = value; },
    onQualityError: (error) => errors.push(error),
    RTCPeerConnectionImpl: RejectingNewPeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-existing']);
  const existing = FakePeerConnection.instances[0];
  const joining = session.setViewers(['viewer-existing', 'viewer-failed']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existing.senders[0].params.encodings[0].maxBitrate, 2_000_000);
  assert.equal(FakePeerConnection.instances[1].offerCalls, 0);
  assert.equal(socket.sent.some(({ event, payload }) => event === 'sala:sinal:oferta' && payload.para === 'viewer-failed'), false);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await joining;

  assert.equal(socket.sent.some(({ event, payload }) => event === 'sala:sinal:oferta' && payload.para === 'viewer-failed'), false);
  assert.equal(session.getPeerCount(), 1, 'only the established viewer should remain');
  assert.equal(existing.senders[0].params.encodings[0].maxBitrate, 4_000_000, 'removed viewer releases its share');
  assert.deepEqual(diagnostics.peers.map((peer) => peer.peerId), ['viewer-existing']);
  assert.ok(errors.some((error) => /três tentativas/.test(error.message)));
  session.close();
});

test('stream peer: drains a quality update queued reentrantly before resolving the current update', async () => {
  FakePeerConnection.instances = [];
  let session;
  let queuedPromise;
  let didQueue = false;
  session = createStreamRoomPeerSession({
    socket: new FakeSocket(),
    roomId: 'room-1',
    role: 'host',
    RTCPeerConnectionImpl: FakePeerConnection,
    setIntervalImpl: () => null,
    onStats: () => {
      if (didQueue) return;
      didQueue = true;
      queuedPromise = session.setQuality({ bitrate: 2_000_000, adaptiveQuality: true });
    },
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a']);
  await queuedPromise;

  assert.equal(didQueue, true);
  assert.equal(FakePeerConnection.instances[0].senders[0].params.encodings[0].maxBitrate, 2_000_000);
  session.close();
});


test('stream peer: an old failed reduction blocks a pending offer even after its cap was applied in an earlier attempt', async () => {
  class RejectingReductionPeerConnection extends FakePeerConnection {
    addTrack(track, stream) {
      const sender = super.addTrack(track, stream);
      sender.rejectParameters = false;
      sender.getParameters = () => ({ ...sender.params, encodings: sender.params.encodings.map((encoding) => ({ ...encoding })) });
      const apply = sender.setParameters;
      sender.setParameters = async (parameters) => {
        if (sender.rejectParameters) throw new Error('reduction rejected');
        return apply(parameters);
      };
      return sender;
    }
  }

  FakePeerConnection.instances = [];
  const scheduled = [];
  const socket = new FakeSocket();
  let session;
  let existingSender;
  let queuedQualityUpdate;
  let triggered = false;
  let diagnostics;
  session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
    onStats: (value) => {
      diagnostics = value;
      if (!triggered && value.peers.length === 2
        && value.peers.every((peer) => peer.targetVideoBitrate === 2_000_000)) {
        triggered = true;
        existingSender.rejectParameters = true;
        queuedQualityUpdate = session.setQuality({ bitrate: 2_000_000, adaptiveQuality: true });
      }
    },
    RTCPeerConnectionImpl: RejectingReductionPeerConnection,
    reconnectDelayMs: 1,
    setTimeoutImpl: (callback, delay) => { if (delay < 10_000) scheduled.push(callback); return callback; },
    clearTimeoutImpl: (timer) => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
    setIntervalImpl: () => null,
  });
  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-existing']);
  const existing = FakePeerConnection.instances[0];
  existingSender = existing.senders[0];

  const joining = session.setViewers(['viewer-existing', 'viewer-new']);
  await new Promise((resolve) => setImmediate(resolve));
  const newcomer = FakePeerConnection.instances[1];
  assert.equal(triggered, true);
  assert.equal(existingSender.params.encodings[0].maxBitrate, 2_000_000);
  assert.equal(newcomer.senders[0].params.encodings[0].maxBitrate, 1_000_000);
  assert.equal(newcomer.offerCalls, 0);
  assert.equal(scheduled.length, 1);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    scheduled.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(newcomer.offerCalls, 0, 'the unchanged new cap cannot bypass an old peer reduction failure');
    assert.equal(scheduled.length, attempt === 0 ? 1 : 0);
  }
  await joining;
  await queuedQualityUpdate;

  assert.equal(socket.sent.some(({ event, payload }) => event === 'sala:sinal:oferta' && payload.para === 'viewer-new'), false);
  assert.equal(session.getPeerCount(), 1);
  assert.deepEqual(diagnostics.peers.map((peer) => peer.peerId), ['viewer-existing']);
  session.close();
});

test('stream peer: signal relay rejection and remote negotiation errors are reported', async () => {
  const sendSocket = new FakeSocket();
  const sendErrors = [];
  sendSocket.id = 'host-a';
  sendSocket.emit = (event, payload, acknowledge) => {
    sendSocket.sent.push({ event, payload });
    if (event === 'sala:sinal:oferta') acknowledge?.({ ok: false, error: 'Este destino não está conectado à sala.' });
  };
  const host = createStreamRoomPeerSession({
    socket: sendSocket,
    roomId: 'room-1',
    role: 'host',
    streamId: 'host-a',
    RTCPeerConnectionImpl: FakePeerConnection,
    onSignalError: (details) => sendErrors.push(details),
  });
  host.setLocalStream(makeStream());
  await host.setViewers(['viewer-a']);
  assert.deepEqual(sendErrors, [{
    type: 'offer',
    peerId: 'viewer-a',
    phase: 'send',
    error: 'Este destino não está conectado à sala.',
  }]);
  host.close();

  class RejectingPeerConnection extends FakePeerConnection {
    async setRemoteDescription() { throw new Error('InvalidStateError'); }
  }
  const receiveSocket = new FakeSocket();
  const receiveErrors = [];
  const viewer = createStreamRoomPeerSession({
    socket: receiveSocket,
    roomId: 'room-1',
    role: 'viewer',
    streamId: 'host-a',
    RTCPeerConnectionImpl: RejectingPeerConnection,
    onSignalError: (details) => receiveErrors.push(details),
  });
  receiveSocket.receive('sala:sinal:oferta', {
    roomId: 'room-1',
    streamId: 'host-a',
    de: 'host-a',
    descricao: { type: 'offer', sdp: 'invalid' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receiveErrors.length, 1);
  assert.equal(receiveErrors[0].type, 'offer');
  assert.equal(receiveErrors[0].phase, 'receive');
  assert.equal(receiveErrors[0].error.message, 'InvalidStateError');
  viewer.close();
});

test('stream peer: ICE watchdog starts at negotiation, not on an early candidate', async () => {
  FakePeerConnection.instances = [];
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const viewer = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'viewer',
    streamId: 'host-a',
    RTCPeerConnectionImpl: FakePeerConnection,
    iceConnectionTimeoutMs: 100,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    setIntervalImpl: () => null,
    clearIntervalImpl: () => {},
  });

  socket.receive('sala:sinal:candidato', {
    roomId: 'room-1', streamId: 'host-a', de: 'host-a', candidato: { candidate: 'early' },
  });
  assert.equal(viewer.getPeerCount(), 1);
  assert.equal(timers.tasks.size, 0, 'an early candidate must not consume the negotiation timeout');

  socket.receive('sala:sinal:oferta', {
    roomId: 'room-1', streamId: 'host-a', de: 'host-a', descricao: { type: 'offer', sdp: 'host-offer' },
  });
  await flushPeerTasks();
  assert.equal(timers.tasks.size, 1, 'the watchdog starts when the offer is processed');
  viewer.close();
  assert.equal(timers.tasks.size, 0, 'closing the session clears the watchdog');
});

test('stream peer: ICE failure retries twice, reports terminal state once, and stops', async () => {
  FakePeerConnection.instances = [];
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const terminalFailures = [];
  const session = createStreamRoomPeerSession({
    socket,
    roomId: 'room-1',
    role: 'host',
    RTCPeerConnectionImpl: FakePeerConnection,
    iceConnectionTimeoutMs: 10,
    reconnectDelayMs: 1,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    setIntervalImpl: () => null,
    clearIntervalImpl: () => {},
    onIceFailure: (peerId, failure) => terminalFailures.push({ peerId, failure }),
  });

  session.setLocalStream(makeStream());
  await session.setViewers(['viewer-a']);
  await flushPeerTasks();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(FakePeerConnection.instances.length, attempt + 1);
    timers.advance(10);
    timers.advance(1);
    await flushPeerTasks();
  }

  assert.equal(socket.sent.filter(({ event }) => event === 'sala:sinal:oferta').length, 3);
  assert.deepEqual(terminalFailures.map(({ peerId, failure }) => [peerId, failure.terminal, failure.attempts, failure.retries]), [
    ['viewer-a', true, 2, 2],
  ]);

  const failedPeer = FakePeerConnection.instances.at(-1);
  failedPeer.connectionState = 'failed';
  failedPeer.onconnectionstatechange?.();
  timers.advance(10_000);
  assert.equal(terminalFailures.length, 1, 'state changes after terminal failure do not re-notify or retry');
  assert.equal(FakePeerConnection.instances.length, 3);
  session.close();
  assert.equal(timers.tasks.size, 0);
});
