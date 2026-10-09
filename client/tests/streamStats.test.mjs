import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getStreamStatsDiagnosis,
  summarizeWebRtcStats,
} from '../src/streamStats.mjs';

function outboundReport({
  timestamp = 1_000,
  id = 'outbound-video',
  ssrc = 101,
  bytesSent = 1_000,
  framesEncoded = 30,
  remoteId = 'remote-inbound-video',
  localId = undefined,
} = {}) {
  const outbound = {
    id,
    type: 'outbound-rtp',
    kind: 'video',
    timestamp,
    ssrc,
    bytesSent,
    framesEncoded,
    frameWidth: 1920,
    frameHeight: 1080,
    codecId: 'codec-vp8',
    transportId: 'transport-1',
    qualityLimitationReason: 'none',
    ...(remoteId ? { remoteId } : {}),
  };
  const remoteInbound = {
    id: remoteId || 'remote-inbound-video',
    type: 'remote-inbound-rtp',
    kind: 'video',
    timestamp,
    ssrc,
    packetsLost: 2,
    fractionLost: 0.01,
    jitter: 0.02,
    roundTripTime: 0.08,
    ...(localId ? { localId } : {}),
  };
  return [
    outbound,
    remoteInbound,
    { id: 'codec-vp8', type: 'codec', mimeType: 'video/VP8', sdpFmtpLine: 'max-fr=30' },
    { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' },
    {
      id: 'pair-1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      currentRoundTripTime: 0.06,
      availableOutgoingBitrate: 5_000_000,
      localCandidateId: 'local-1',
    },
    { id: 'local-1', type: 'local-candidate', candidateType: 'host' },
  ];
}

test('outbound video: reads codec, remote feedback and selected transport pair', () => {
  const result = summarizeWebRtcStats(new Map(outboundReport().map((entry) => [entry.id, entry])));

  assert.equal(result.metrics.direction, 'outbound');
  assert.equal(result.metrics.codec, 'video/VP8');
  assert.equal(result.metrics.codecFmtpLine, 'max-fr=30');
  assert.equal(result.metrics.frameWidth, 1920);
  assert.equal(result.metrics.frameHeight, 1080);
  assert.equal(result.metrics.qualityLimitationReason, 'none');
  assert.equal(result.metrics.remoteRoundTripTimeSeconds, 0.08);
  assert.equal(result.metrics.candidatePairRoundTripTimeSeconds, 0.06);
  assert.equal(result.metrics.roundTripTimeSeconds, 0.08);
  assert.equal(result.metrics.fractionLost, 0.01);
  assert.equal(result.metrics.packetsLost, 2);
  assert.equal(result.metrics.jitterSeconds, 0.02);
  assert.equal(result.metrics.availableOutgoingBitrate, 5_000_000);
  assert.equal(result.metrics.candidateType, 'host');
  assert.equal(result.metrics.bitrateBps, null);
  assert.equal(result.metrics.framesPerSecond, null);
  assert.equal(result.counters.identity, 'outbound-rtp:outbound-video:101');
});

test('outbound video: calculates bit rate and frame rate from timestamped counter deltas', () => {
  const first = summarizeWebRtcStats(outboundReport({
    timestamp: 1_000,
    bytesSent: 20_000,
    framesEncoded: 30,
  }));
  const second = summarizeWebRtcStats(outboundReport({
    timestamp: 3_000,
    bytesSent: 1_020_000,
    framesEncoded: 90,
  }), first.counters);

  assert.equal(second.metrics.bitrateBps, 4_000_000);
  assert.equal(second.metrics.framesPerSecond, 30);
});

test('outbound video: matches remote-inbound through reciprocal localId if remoteId is absent', () => {
  const reports = outboundReport({ remoteId: null, localId: 'outbound-video' });
  const result = summarizeWebRtcStats(reports);

  assert.equal(result.metrics.roundTripTimeSeconds, 0.08);
  assert.equal(result.metrics.fractionLost, 0.01);
  assert.equal(result.metrics.packetsLost, 2);
});

test('inbound video: parses received metrics and uses a selected pair from the transport', () => {
  const reports = [
    {
      id: 'inbound-video',
      type: 'inbound-rtp',
      mediaType: 'video',
      timestamp: 2_000,
      ssrc: 202,
      bytesReceived: 300_000,
      framesDecoded: 60,
      frameWidth: 1280,
      frameHeight: 720,
      framesDropped: 3,
      freezeCount: 1,
      packetsLost: 4,
      jitter: 0.03,
      codecId: 'codec-h264',
      transportId: 'transport-2',
    },
    { id: 'codec-h264', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
    { id: 'transport-2', type: 'transport', selectedCandidatePairId: 'pair-2' },
    {
      id: 'pair-2',
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.12,
      availableOutgoingBitrate: 1_000_000,
      localCandidateId: 'local-2',
    },
    { id: 'local-2', type: 'local-candidate', candidateType: 'relay' },
  ];
  const first = summarizeWebRtcStats(reports);
  const second = summarizeWebRtcStats([
    { ...reports[0], timestamp: 4_000, bytesReceived: 800_000, framesDecoded: 120 },
    ...reports.slice(1),
  ], first.counters);

  assert.equal(second.metrics.direction, 'inbound');
  assert.equal(second.metrics.bitrateBps, 2_000_000);
  assert.equal(second.metrics.framesPerSecond, 30);
  assert.equal(second.metrics.frameWidth, 1280);
  assert.equal(second.metrics.frameHeight, 720);
  assert.equal(second.metrics.codec, 'video/H264');
  assert.equal(second.metrics.qualityLimitationReason, null);
  assert.equal(second.metrics.packetsLost, 4);
  assert.equal(second.metrics.jitterSeconds, 0.03);
  assert.equal(second.metrics.framesDropped, 3);
  assert.equal(second.metrics.freezeCount, 1);
  assert.equal(second.metrics.roundTripTimeSeconds, 0.12);
  assert.equal(second.metrics.candidateType, 'relay');
});

test('reports with missing or partial fields return null metrics without throwing', () => {
  const empty = summarizeWebRtcStats(null);
  const partial = summarizeWebRtcStats([{ id: 'video', type: 'inbound-rtp', kind: 'video' }]);

  assert.equal(empty.metrics.direction, null);
  assert.equal(empty.counters, null);
  assert.equal(empty.metrics.bitrateBps, null);
  assert.equal(empty.metrics.codec, null);
  assert.equal(partial.metrics.direction, 'inbound');
  assert.equal(partial.metrics.framesPerSecond, null);
  assert.equal(partial.metrics.roundTripTimeSeconds, null);
  assert.equal(partial.metrics.availableOutgoingBitrate, null);
  assert.equal(partial.counters.bytes, null);
  assert.equal(partial.counters.frames, null);
  assert.deepEqual(summarizeWebRtcStats({ get values() { throw new Error('partial report'); } }).metrics, {
    direction: null,
    bitrateBps: null,
    framesPerSecond: null,
    frameWidth: null,
    frameHeight: null,
    codec: null,
    codecFmtpLine: null,
    qualityLimitationReason: null,
    roundTripTimeSeconds: null,
    remoteRoundTripTimeSeconds: null,
    candidatePairRoundTripTimeSeconds: null,
    fractionLost: null,
    packetsLost: null,
    packetsReceived: null,
    jitterSeconds: null,
    framesDropped: null,
    freezeCount: null,
    availableOutgoingBitrate: null,
    candidateType: null,
  });
});

test('counter resets and changed SSRC do not produce negative or cross-stream rates', () => {
  const first = summarizeWebRtcStats(outboundReport({
    timestamp: 1_000,
    bytesSent: 500_000,
    framesEncoded: 30,
  }));
  const changedSsrc = summarizeWebRtcStats(outboundReport({
    timestamp: 3_000,
    ssrc: 303,
    bytesSent: 100,
    framesEncoded: 2,
  }), first.counters);
  const decreasedCounters = summarizeWebRtcStats(outboundReport({
    timestamp: 5_000,
    ssrc: 303,
    bytesSent: 50,
    framesEncoded: 1,
  }), changedSsrc.counters);

  assert.equal(changedSsrc.metrics.bitrateBps, null);
  assert.equal(changedSsrc.metrics.framesPerSecond, null);
  assert.equal(decreasedCounters.metrics.bitrateBps, null);
  assert.equal(decreasedCounters.metrics.framesPerSecond, null);
});

test('diagnosis reports encoder CPU, converging network signals, or insufficient evidence cautiously', () => {
  assert.equal(getStreamStatsDiagnosis({ qualityLimitationReason: 'cpu' }).status, 'cpu');
  assert.equal(getStreamStatsDiagnosis({ qualityLimitationReason: 'bandwidth' }).status, 'network');
  assert.equal(getStreamStatsDiagnosis({
    fractionLost: 0.04,
    roundTripTimeSeconds: 0.3,
  }).status, 'network');
  assert.equal(getStreamStatsDiagnosis({
    qualityLimitationReason: 'none',
    fractionLost: 0,
    roundTripTimeSeconds: 0.04,
  }).status, 'insufficient');
});
test('inbound video: computes interval packet loss from valid cumulative counter deltas', () => {
  const first = summarizeWebRtcStats([{
    id: 'inbound-loss',
    type: 'inbound-rtp',
    kind: 'video',
    timestamp: 1_000,
    packetsLost: 10,
    packetsReceived: 990,
    fractionLost: 0.2,
  }]);
  const second = summarizeWebRtcStats([{
    id: 'inbound-loss',
    type: 'inbound-rtp',
    kind: 'video',
    timestamp: 3_000,
    packetsLost: 20,
    packetsReceived: 1_980,
    fractionLost: 0.2,
  }], first.counters);

  assert.equal(first.metrics.fractionLost, 0.2);
  assert.equal(second.metrics.fractionLost, 0.01);
  assert.equal(second.metrics.packetsLost, 20);
  assert.equal(second.metrics.packetsReceived, 1_980);
  assert.equal(second.counters.packetsLost, 20);
  assert.equal(second.counters.packetsReceived, 1_980);

  const reset = summarizeWebRtcStats([{
    id: 'inbound-loss',
    type: 'inbound-rtp',
    kind: 'video',
    timestamp: 5_000,
    packetsLost: 2,
    packetsReceived: 2_500,
    fractionLost: 0.05,
  }], second.counters);
  assert.equal(reset.metrics.fractionLost, 0.05);
});
