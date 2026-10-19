import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamRoomPeerSession } from '../src/streamRoomPeer.mjs';

class Socket {
  id = 'host';
  on() {}
  off() {}
  emit() {}
}

class StatsPeer {
  static instances = [];
  connectionState = 'new';
  signalingState = 'stable';
  senders = [];
  reports = [];
  constructor() { StatsPeer.instances.push(this); }
  addTrack(track) {
    const sender = {
      track,
      params: { encodings: [{}] },
      getParameters() { return structuredClone(this.params); },
      async setParameters(parameters) { this.params = structuredClone(parameters); },
    };
    this.senders.push(sender);
    return sender;
  }
  getSenders() { return this.senders; }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async getStats() { return new Map(this.reports.map((report) => [report.id, report])); }
  close() { this.connectionState = 'closed'; }
}

const cap = (peer) => peer.senders[0].params.encodings[0].maxBitrate;

async function fixture(t, { viewers = ['viewer'], adaptiveQuality = true } = {}) {
  StatsPeer.instances = [];
  const session = createStreamRoomPeerSession({
    socket: new Socket(), roomId: 'recovery-test', role: 'host',
    quality: { bitrate: 4_000_000, adaptiveQuality },
    RTCPeerConnectionImpl: StatsPeer,
    iceServers: [],
    setIntervalImpl: () => null, clearIntervalImpl: () => {},
    setTimeoutImpl: () => null, clearTimeoutImpl: () => {},
    resolveVideoCodecPreferencesImpl: async () => [],
  });
  t.after(() => session.close());
  session.setLocalStream({ getTracks: () => [{ kind: 'video', id: 'screen' }] });
  await session.setViewers(viewers);
  const peers = [...StatsPeer.instances];
  for (const peer of peers) {
    peer.connectionState = 'connected';
    peer.sampleTime = 0;
    peer.bytes = 0;
    peer.frames = 0;
  }
  function prepare(peer, {
    available = 1_000_000, reason = 'none', rtt = 0.08, loss = 0.005,
    utilization = 0.9, frameRate = 60, timestamp = peer.sampleTime + 2_000, ssrc = 42,
  } = {}) {
    const durationSeconds = Math.max(0, (timestamp - peer.sampleTime) / 1_000);
    peer.bytes += Math.floor(cap(peer) * utilization * durationSeconds / 8);
    peer.frames += Math.floor(frameRate * durationSeconds);
    peer.sampleTime = timestamp;
    peer.reports = [
      { id: 'outbound', type: 'outbound-rtp', kind: 'video', ssrc, timestamp,
        bytesSent: peer.bytes, framesEncoded: peer.frames,
        qualityLimitationReason: reason, transportId: 'transport', remoteId: 'feedback' },
      { id: 'feedback', type: 'remote-inbound-rtp', kind: 'video', localId: 'outbound',
        fractionLost: loss, roundTripTime: rtt },
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
      { id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true,
        currentRoundTripTime: rtt, availableOutgoingBitrate: available },
    ];
  }
  async function sample(options = {}) {
    peers.forEach((peer, index) => prepare(peer, Array.isArray(options) ? options[index] : options));
    await session.refreshStats();
  }
  async function reduce() {
    await sample({ reason: 'bandwidth', loss: 0.05 });
    await sample({ reason: 'bandwidth', loss: 0.05 });
    assert.equal(cap(peers[0]), 850_000);
  }
  return { session, peers, prepare, sample, reduce };
}

test('adaptive recovery opens a reduced ceiling after six healthy intervals even while BWE stays flat', async (t) => {
  const { peers: [peer], reduce, sample } = await fixture(t);
  await reduce();
  for (let count = 0; count < 5; count += 1) {
    await sample();
    assert.equal(cap(peer), 850_000);
  }
  await sample();
  assert.equal(cap(peer), 977_500);
  // 15% opens the existing capacity ceiling; the allocator applies its 85%
  // network margin once. Multiplying the applied cap by 85% again would fail.
  assert.ok(cap(peer) > 850_000);
  await sample();
  assert.equal(cap(peer), 977_500);
});

test('adaptive recovery rejects repeated and out-of-order report timestamps and restarts its stable interval count', async (t) => {
  const { session, peers: [peer], reduce, sample, prepare } = await fixture(t);
  await reduce();
  for (let count = 0; count < 5; count += 1) await sample();
  for (let count = 0; count < 10; count += 1) await session.refreshStats();
  assert.equal(cap(peer), 850_000);
  const latestTimestamp = peer.sampleTime;
  prepare(peer, { timestamp: latestTimestamp - 2_000 });
  await session.refreshStats();
  prepare(peer, { timestamp: latestTimestamp });
  await session.refreshStats();
  assert.equal(cap(peer), 850_000);
  for (let count = 0; count < 5; count += 1) {
    await sample();
    assert.equal(cap(peer), 850_000);
  }
  await sample();
  assert.equal(cap(peer), 977_500);
});

for (const [name, unhealthy] of [
  ['CPU pressure', { reason: 'cpu' }],
  ['high RTT', { rtt: 0.3 }],
  ['packet loss', { loss: 0.05 }],
  ['missing receiver feedback', { loss: null, rtt: null }],
  ['idle content', { utilization: 0.1 }],
  ['stopped frames', { frameRate: 0 }],
]) {
  test(`adaptive recovery does not probe through ${name}`, async (t) => {
    const { peers: [peer], reduce, sample } = await fixture(t);
    await reduce();
    for (let count = 0; count < 4; count += 1) await sample();
    await sample(unhealthy);
    for (let count = 0; count < 5; count += 1) {
      await sample();
      assert.equal(cap(peer), 850_000);
    }
    await sample();
    assert.equal(cap(peer), 977_500);
  });
}

test('adaptive recovery reduces again when congestion recurs and requires another full stable interval', async (t) => {
  const { peers: [peer], reduce, sample } = await fixture(t);
  await reduce();
  for (let count = 0; count < 6; count += 1) await sample();
  assert.equal(cap(peer), 977_500);
  await sample({ reason: 'bandwidth', available: 300_000 });
  assert.equal(cap(peer), 977_500);
  await sample({ reason: 'bandwidth', available: 300_000 });
  const reducedCap = cap(peer);
  assert.ok(reducedCap < 850_000);
  const stableBwe = reducedCap / 0.85;
  for (let count = 0; count < 5; count += 1) {
    await sample({ available: stableBwe });
    assert.equal(cap(peer), reducedCap);
  }
  await sample({ available: stableBwe });
  assert.ok(cap(peer) > reducedCap && cap(peer) <= Math.floor(reducedCap * 1.15) + 1);
});

test('adaptive recovery reallocates gradual probes within the aggregate room budget', async (t) => {
  const { peers: [weak, strong], sample } = await fixture(t, { viewers: ['weak', 'strong'] });
  const drop = [{ reason: 'bandwidth', loss: 0.05 }, { reason: 'none', available: 8_000_000 }];
  await sample(drop);
  await sample(drop);
  assert.equal(cap(weak), 850_000);
  assert.equal(cap(strong), 3_150_000);
  for (let count = 0; count < 6; count += 1) {
    await sample([{}, { available: 8_000_000 }]);
    assert.ok(cap(weak) + cap(strong) <= 4_000_000);
  }
  assert.equal(cap(weak), 977_500);
  assert.equal(cap(strong), 3_022_500);
});

test('adaptive recovery stays disabled when automatic quality is disabled', async (t) => {
  const { peers: [peer], sample } = await fixture(t, { adaptiveQuality: false });
  await sample({ reason: 'bandwidth' });
  await sample({ reason: 'bandwidth' });
  for (let count = 0; count < 20; count += 1) await sample();
  assert.equal(cap(peer), 4_000_000);
});

test('adaptive recovery can reopen a zero estimate when new measured headroom becomes available', async (t) => {
  const { peers: [peer], sample } = await fixture(t);
  await sample({ reason: 'bandwidth', available: 0, loss: 0.05 });
  await sample({ reason: 'bandwidth', available: 0, loss: 0.05 });
  assert.equal(cap(peer), 0);
  for (let count = 0; count < 6; count += 1) await sample({ available: 1_000_000 });
  assert.equal(cap(peer), 85_000);
});

test('adaptive recovery restarts its stable interval count after a failed stats collection', async (t) => {
  const { session, peers: [peer], reduce, sample } = await fixture(t);
  await reduce();
  for (let count = 0; count < 4; count += 1) await sample();
  const getStats = peer.getStats;
  peer.getStats = async () => { throw new Error('stats unavailable'); };
  await session.refreshStats();
  peer.getStats = getStats;
  for (let count = 0; count < 5; count += 1) {
    await sample();
    assert.equal(cap(peer), 850_000);
  }
  await sample();
  assert.equal(cap(peer), 977_500);
});

for (const available of [0, 580_000]) {
  test(`adaptive allocation keeps the room ceiling during 20 clean cold-start bandwidth reports at ${available} bps`, async (t) => {
    const { peers: [peer], sample } = await fixture(t);
    for (let count = 0; count < 20; count += 1) {
      await sample({ reason: 'bandwidth', available, rtt: 0.001, loss: 0, utilization: 0.1 });
      assert.equal(cap(peer), 4_000_000);
    }
  });
}

test('adaptive allocation reduces a formerly established sender after later sustained bandwidth pressure', async (t) => {
  const { peers: [peer], sample } = await fixture(t);
  for (let count = 0; count < 3; count += 1) await sample({ available: 4_000_000 });
  await sample({ reason: 'bandwidth', available: 500_000, loss: 0, rtt: 0.001 });
  assert.equal(cap(peer), 4_000_000);
  await sample({ reason: 'bandwidth', available: 500_000, loss: 0, rtt: 0.001 });
  assert.ok(cap(peer) < 4_000_000);
});

test('adaptive allocation does not mistake static content for an established high-throughput sender', async (t) => {
  const { peers: [peer], sample } = await fixture(t);
  for (let count = 0; count < 6; count += 1) {
    await sample({ available: 500_000, utilization: 0.02, loss: 0, rtt: 0.001 });
  }
  for (let count = 0; count < 20; count += 1) {
    await sample({ reason: 'bandwidth', available: 500_000, utilization: 0.1, loss: 0, rtt: 0.001 });
    assert.equal(cap(peer), 4_000_000);
  }
});

test('adaptive allocation keeps equal aggregate ceilings while new viewers ramp up on clean links', async (t) => {
  const { peers, sample } = await fixture(t, { viewers: ['first', 'second'] });
  for (let count = 0; count < 20; count += 1) {
    await sample({ reason: 'bandwidth', available: 580_000, utilization: 0.1, loss: 0, rtt: 0.001 });
    assert.deepEqual(peers.map(cap), [2_000_000, 2_000_000]);
  }
});

test('adaptive allocation reopens a changed quality profile and relearns its native ramp-up', async (t) => {
  const { session, peers: [peer], sample } = await fixture(t);
  for (let count = 0; count < 3; count += 1) await sample({ available: 4_000_000 });
  await sample({ reason: 'bandwidth', loss: 0.05 });
  await sample({ reason: 'bandwidth', loss: 0.05 });
  assert.ok(cap(peer) < 4_000_000);
  await session.setQuality({ bitrate: 8_000_000, resolution: '720p', adaptiveQuality: true });
  assert.equal(cap(peer), 8_000_000);
  for (let count = 0; count < 20; count += 1) {
    await sample({ reason: 'bandwidth', available: 580_000, utilization: 0.1, loss: 0, rtt: 0.001 });
    assert.equal(cap(peer), 8_000_000);
  }
});

for (const restart of ['ssrc', 'counters', 'timestamp']) {
  test(`adaptive allocation resets established media history after a ${restart} restart`, async (t) => {
    const { peers: [peer], sample } = await fixture(t);
    for (let count = 0; count < 3; count += 1) await sample({ available: 4_000_000 });
    if (restart === 'counters') { peer.bytes = 0; peer.frames = 0; }
    if (restart === 'timestamp') peer.sampleTime = 0;
    for (let count = 0; count < 20; count += 1) {
      await sample({ reason: 'bandwidth', available: 500_000, utilization: 0.1, loss: 0, rtt: 0.001,
        ssrc: restart === 'ssrc' ? 100 : 42 });
      assert.equal(cap(peer), 4_000_000);
    }
  });
}

test('adaptive allocation keeps established history across a transient stats failure', async (t) => {
  const { session, peers: [peer], sample } = await fixture(t);
  for (let count = 0; count < 3; count += 1) await sample({ available: 4_000_000 });
  const getStats = peer.getStats;
  peer.getStats = async () => { throw new Error('stats unavailable'); };
  await session.refreshStats();
  peer.getStats = getStats;
  for (let count = 0; count < 2; count += 1) {
    await sample({ reason: 'bandwidth', available: 500_000, utilization: 0.1, loss: 0, rtt: 0.001 });
  }
  assert.ok(cap(peer) < 4_000_000);
});
