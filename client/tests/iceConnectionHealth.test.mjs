import test from 'node:test';
import assert from 'node:assert/strict';
import { createIceConnectionHealthMonitor } from '../src/iceConnectionHealth.mjs';

class FakePeer {
  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class FakeTimers {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

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

test('ICE health publishes state and counts candidate types without retaining candidate data', () => {
  const peer = new FakePeer();
  const reports = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    onStatus: (status) => reports.push(status),
  });

  peer.iceConnectionState = 'checking';
  peer.dispatch('iceconnectionstatechange');
  peer.iceGatheringState = 'gathering';
  peer.dispatch('icegatheringstatechange');
  peer.dispatch('icecandidate', {
    candidate: { type: 'host', address: '192.168.1.20', port: 54321, candidate: 'candidate:private-sdp' },
  });
  peer.dispatch('icecandidate', {
    candidate: { type: 'srflx', address: '203.0.113.42', port: 60000, candidate: 'candidate:public-sdp' },
  });
  peer.dispatch('icecandidate', {
    candidate: { type: 'relay', address: '198.51.100.8', port: 3478, candidate: 'candidate:relay-sdp' },
  });
  peer.dispatch('icecandidate', {
    candidate: { type: 'prflx', address: '192.0.2.10', candidate: 'candidate:peer-reflexive' },
  });
  peer.dispatch('icecandidate', {
    candidate: { type: 'unrecognized', address: '10.0.0.1', candidate: 'candidate:unknown' },
  });

  const latest = reports.at(-1);
  assert.equal(latest.iceConnectionState, 'checking');
  assert.equal(latest.iceGatheringState, 'gathering');
  assert.deepEqual(latest.candidateCounts, { host: 1, srflx: 1, prflx: 1, relay: 1 });
  assert.equal(JSON.stringify(latest).includes('192.168.1.20'), false);
  assert.equal(JSON.stringify(latest).includes('candidate:private-sdp'), false);

  monitor.close();
});

test('ICE health reports only a candidate error count and numeric code', () => {
  const peer = new FakePeer();
  let latest;
  const monitor = createIceConnectionHealthMonitor({
    peer,
    onStatus: (status) => { latest = status; },
  });

  peer.dispatch('icecandidateerror', {
    errorCode: 701,
    errorText: 'failed at 10.20.30.40 with secret',
    address: '10.20.30.40',
    port: 3478,
    url: 'turn:relay.example?credential=secret',
  });

  assert.equal(latest.candidateErrorCount, 1);
  assert.equal(latest.lastCandidateErrorCode, 701);
  const serialized = JSON.stringify(latest);
  assert.equal(serialized.includes('10.20.30.40'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('relay.example'), false);

  monitor.close();
});

test('ICE watchdog starts at negotiation time, including a peer created by an early candidate', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 50,
    nowImpl: () => timers.now,
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  peer.iceGatheringState = 'gathering';
  peer.dispatch('icegatheringstatechange');
  peer.dispatch('icecandidate', { candidate: { type: 'host', address: 'private-address' } });
  assert.equal(timers.tasks.size, 0);
  assert.equal(failures.length, 0);

  monitor.start();
  assert.equal(timers.tasks.size, 1);
  timers.advance(49);
  assert.equal(failures.length, 0);
  timers.advance(1);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'timeout');
  assert.equal(failures[0].elapsedMs, 50);
  assert.equal(failures[0].iceGatheringState, 'gathering');
  monitor.close();
});

test('ICE health times out one prolonged connecting/checking attempt exactly once', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 500,
    nowImpl: () => timers.now,
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  monitor.start();
  peer.iceConnectionState = 'checking';
  peer.connectionState = 'connecting';
  peer.dispatch('iceconnectionstatechange');
  timers.advance(499);
  assert.equal(failures.length, 0);

  timers.advance(1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'timeout');
  assert.equal(failures[0].timeoutMs, 500);
  assert.equal(failures[0].elapsedMs, 500);
  assert.equal(failures[0].iceConnectionState, 'checking');

  peer.dispatch('iceconnectionstatechange');
  timers.advance(1_000);
  assert.equal(failures.length, 1);
  monitor.close();
});

test('ICE connected alone does not cancel the watchdog while the peer connection is still connecting', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 100,
    nowImpl: () => timers.now,
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  monitor.start();
  peer.iceConnectionState = 'connected';
  peer.connectionState = 'connecting';
  peer.dispatch('iceconnectionstatechange');
  assert.equal(timers.tasks.size, 1);
  timers.advance(100);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'timeout');
  assert.equal(failures[0].iceConnectionState, 'connected');
  assert.equal(failures[0].connectionState, 'connecting');
  monitor.close();
});

test('ICE health cancels the pending timeout when the peer connection connects', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 300,
    nowImpl: () => timers.now,
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  monitor.start();
  peer.iceConnectionState = 'checking';
  peer.dispatch('iceconnectionstatechange');
  peer.iceConnectionState = 'connected';
  peer.connectionState = 'connected';
  peer.dispatch('iceconnectionstatechange');
  peer.dispatch('connectionstatechange');
  timers.advance(1_000);

  assert.equal(failures.length, 0);
  assert.equal(timers.tasks.size, 0);
  monitor.close();
});

test('ICE watchdog does not fail when connection becomes connected at the timeout boundary', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 100,
    nowImpl: () => timers.now,
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  monitor.start();
  peer.connectionState = 'connected';
  timers.advance(100);

  assert.equal(failures.length, 0);
  assert.equal(timers.tasks.size, 0);
  monitor.close();
});
test('ICE failure before start is reported on start and cleanup detaches all observers', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const reports = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 200,
    nowImpl: () => timers.now,
    onStatus: (status) => reports.push(status),
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  peer.iceConnectionState = 'failed';
  peer.connectionState = 'failed';
  peer.dispatch('iceconnectionstatechange');
  assert.equal(failures.length, 0);
  monitor.start();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'ice-failed');
  assert.equal(timers.tasks.size, 0);

  const reportCount = reports.length;
  monitor.close();
  peer.iceGatheringState = 'complete';
  peer.dispatch('icegatheringstatechange');
  timers.advance(1_000);
  assert.equal(reports.length, reportCount);
  assert.equal(failures.length, 1);
  assert.equal(peer.listeners.get('icecandidate')?.size || 0, 0);
});

test('ICE health cleanup cancels a pending timeout and ignores later peer events', () => {
  const peer = new FakePeer();
  const timers = new FakeTimers();
  const failures = [];
  const reports = [];
  const monitor = createIceConnectionHealthMonitor({
    peer,
    timeoutMs: 100,
    nowImpl: () => timers.now,
    onStatus: (status) => reports.push(status),
    onFailure: (failure) => failures.push(failure),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  monitor.start();
  peer.iceConnectionState = 'checking';
  peer.dispatch('iceconnectionstatechange');
  assert.equal(timers.tasks.size, 1);

  monitor.close();
  peer.iceConnectionState = 'failed';
  peer.dispatch('iceconnectionstatechange');
  timers.advance(1_000);

  assert.equal(timers.tasks.size, 0);
  assert.equal(failures.length, 0);
  assert.equal(reports.at(-1).iceConnectionState, 'checking');
});