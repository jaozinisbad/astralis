const EMPTY_METRICS = Object.freeze({
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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readReports(report) {
  if (!report) return [];
  try {
    if (Array.isArray(report)) return report.filter((item) => item && typeof item === 'object');
    if (typeof report.values === 'function') {
      return Array.from(report.values()).filter((item) => item && typeof item === 'object');
    }
    if (typeof report[Symbol.iterator] === 'function') {
      return Array.from(report, (entry) => Array.isArray(entry) && entry.length === 2 ? entry[1] : entry)
        .filter((item) => item && typeof item === 'object');
    }
    return Object.values(report).filter((item) => item && typeof item === 'object');
  } catch {
    return [];
  }
}

function isVideo(report) {
  return report?.kind === 'video' || report?.mediaType === 'video';
}

function streamScore(report) {
  const active = report.active === true ? 1 : 0;
  const area = (finiteNumber(report.frameWidth) || 0) * (finiteNumber(report.frameHeight) || 0);
  const bytes = finiteNumber(report.bytesSent ?? report.bytesReceived) || 0;
  return [active, area, bytes];
}

function selectVideoStream(reports, type) {
  return reports
    .filter((item) => item.type === type && isVideo(item))
    .sort((left, right) => {
      const leftScore = streamScore(left);
      const rightScore = streamScore(right);
      for (let index = 0; index < leftScore.length; index += 1) {
        if (leftScore[index] !== rightScore[index]) return rightScore[index] - leftScore[index];
      }
      return String(left.id || '').localeCompare(String(right.id || ''));
    })[0] || null;
}

function matchingRemoteInbound(reports, outbound) {
  if (!outbound) return null;
  const remoteReports = reports.filter((item) => item.type === 'remote-inbound-rtp' && isVideo(item));
  const referenced = outbound.remoteId
    ? remoteReports.find((item) => item.id === outbound.remoteId)
    : null;
  if (referenced) return referenced;

  const reciprocal = remoteReports.find((item) => item.localId && item.localId === outbound.id);
  if (reciprocal) return reciprocal;

  if (outbound.ssrc !== undefined && outbound.ssrc !== null) {
    const bySsrc = remoteReports.find((item) => item.ssrc !== undefined && String(item.ssrc) === String(outbound.ssrc));
    if (bySsrc) return bySsrc;
  }
  return null;
}

function selectedCandidatePair(reports, stream) {
  const pairs = reports.filter((item) => item.type === 'candidate-pair');
  const transports = reports.filter((item) => item.type === 'transport');
  const transport = stream?.transportId
    ? transports.find((item) => item.id === stream.transportId)
    : transports.length === 1 ? transports[0] : null;

  if (transport?.selectedCandidatePairId) {
    const pair = pairs.find((item) => item.id === transport.selectedCandidatePairId);
    if (pair) return pair;
  }

  const selected = pairs.filter((item) => item.selected === true);
  if (selected.length === 1) return selected[0];
  const nominated = pairs.filter((item) => item.nominated === true && item.state === 'succeeded');
  return nominated.length === 1 ? nominated[0] : null;
}

function compatiblePrevious(previousCounters, identity) {
  if (!previousCounters || typeof previousCounters !== 'object') return null;
  if (previousCounters.identity !== identity) return null;
  return previousCounters;
}

function intervalRate(currentValue, previousValue, currentTimestamp, previousTimestamp) {
  const now = finiteNumber(currentTimestamp);
  const before = finiteNumber(previousTimestamp);
  const current = finiteNumber(currentValue);
  const previous = finiteNumber(previousValue);
  if (now === null || before === null || now <= before || current === null || previous === null || current < previous) return null;
  return { delta: current - previous, seconds: (now - before) / 1000 };
}

function intervalPacketLossFraction(current, previous) {
  const now = finiteNumber(current?.timestamp);
  const before = finiteNumber(previous?.timestamp);
  const currentLost = finiteNumber(current?.packetsLost);
  const previousLost = finiteNumber(previous?.packetsLost);
  const currentReceived = finiteNumber(current?.packetsReceived);
  const previousReceived = finiteNumber(previous?.packetsReceived);
  if (now === null || before === null || now <= before
    || currentLost === null || previousLost === null
    || currentReceived === null || previousReceived === null) return null;

  const lost = currentLost - previousLost;
  const received = currentReceived - previousReceived;
  const expected = lost + received;
  if (lost < 0 || received < 0 || expected <= 0) return null;
  return lost / expected;
}

function reportIdentity(stream) {
  if (!stream) return null;
  const id = stream.id === undefined || stream.id === null ? '' : String(stream.id);
  const ssrc = stream.ssrc === undefined || stream.ssrc === null ? '' : String(stream.ssrc);
  return [stream.type || '', id, ssrc].join(':');
}

function getStreamCounters(stream) {
  if (!stream) return null;
  const isOutbound = stream.type === 'outbound-rtp';
  return {
    identity: reportIdentity(stream),
    timestamp: finiteNumber(stream.timestamp),
    bytes: finiteNumber(isOutbound ? stream.bytesSent : stream.bytesReceived),
    frames: finiteNumber(isOutbound ? stream.framesEncoded ?? stream.framesSent : stream.framesDecoded ?? stream.framesReceived),
    packetsLost: finiteNumber(stream.packetsLost),
    packetsReceived: finiteNumber(stream.packetsReceived),
  };
}

/**
 * Summarize a complete WebRTC RTCStatsReport or an iterable/array of stats.
 * previousCounters should be the counters returned by the previous call
 * for this same peer connection. Rates are null until a comparable interval
 * exists. The returned counters are cumulative snapshots from this sample.
 */
export function summarizeWebRtcStats(report, previousCounters = null) {
  const reports = readReports(report);
  const outbound = selectVideoStream(reports, 'outbound-rtp');
  const inbound = selectVideoStream(reports, 'inbound-rtp');
  const stream = outbound || inbound;
  const direction = outbound ? 'outbound' : inbound ? 'inbound' : null;
  const streamStats = stream ? getStreamCounters(stream) : null;
  const previous = streamStats ? compatiblePrevious(previousCounters, streamStats.identity) : null;
  const metrics = { ...EMPTY_METRICS, direction };

  if (!stream) return { metrics, counters: null };

  const codec = stream.codecId ? reports.find((item) => item.type === 'codec' && item.id === stream.codecId) : null;
  const remoteInbound = outbound ? matchingRemoteInbound(reports, outbound) : null;
  const pair = selectedCandidatePair(reports, stream);

  metrics.frameWidth = finiteNumber(stream.frameWidth);
  metrics.frameHeight = finiteNumber(stream.frameHeight);
  metrics.codec = typeof codec?.mimeType === 'string' ? codec.mimeType : null;
  metrics.codecFmtpLine = typeof codec?.sdpFmtpLine === 'string' ? codec.sdpFmtpLine : null;
  metrics.qualityLimitationReason = outbound
    && ['none', 'cpu', 'bandwidth', 'other'].includes(stream.qualityLimitationReason)
    ? stream.qualityLimitationReason
    : null;
  metrics.remoteRoundTripTimeSeconds = finiteNumber(remoteInbound?.roundTripTime);
  metrics.candidatePairRoundTripTimeSeconds = finiteNumber(pair?.currentRoundTripTime);
  metrics.roundTripTimeSeconds = metrics.remoteRoundTripTimeSeconds
    ?? metrics.candidatePairRoundTripTimeSeconds;
  const reportedFractionLost = finiteNumber(outbound ? remoteInbound?.fractionLost : stream.fractionLost);
  metrics.fractionLost = inbound
    ? intervalPacketLossFraction(streamStats, previous) ?? reportedFractionLost
    : reportedFractionLost;
  metrics.packetsLost = finiteNumber(outbound ? remoteInbound?.packetsLost : stream.packetsLost);
  metrics.packetsReceived = finiteNumber(outbound ? remoteInbound?.packetsReceived : stream.packetsReceived);
  metrics.jitterSeconds = finiteNumber(outbound ? remoteInbound?.jitter : stream.jitter);
  metrics.framesDropped = inbound ? finiteNumber(stream.framesDropped) : null;
  metrics.freezeCount = inbound ? finiteNumber(stream.freezeCount) : null;
  metrics.availableOutgoingBitrate = finiteNumber(pair?.availableOutgoingBitrate);
  metrics.candidateType = typeof pair?.localCandidateId === 'string'
    ? reports.find((item) => item.type === 'local-candidate' && item.id === pair.localCandidateId)?.candidateType ?? null
    : null;

  if (previous) {
    const byteRate = intervalRate(streamStats.bytes, previous.bytes, streamStats.timestamp, previous.timestamp);
    if (byteRate && byteRate.seconds > 0) metrics.bitrateBps = (byteRate.delta * 8) / byteRate.seconds;

    const frameRate = intervalRate(streamStats.frames, previous.frames, streamStats.timestamp, previous.timestamp);
    if (frameRate && frameRate.seconds > 0) metrics.framesPerSecond = frameRate.delta / frameRate.seconds;
  }

  return { metrics, counters: streamStats };
}

/** Return a cautious, user-facing diagnosis based on converging WebRTC signals. */
export function getStreamStatsDiagnosis(metrics = {}) {
  if (!metrics || typeof metrics !== 'object') {
    return { status: 'insufficient', text: 'Ainda não há dados suficientes para apontar a causa.' };
  }

  if (metrics.qualityLimitationReason === 'cpu') {
    return { status: 'cpu', text: 'O codificador indica possível limitação de CPU; confirme se isso persiste em outras amostras.' };
  }

  if (metrics.qualityLimitationReason === 'bandwidth') {
    return { status: 'network', text: 'O codificador indica possível limitação de rede; compare também RTT e perda em outras amostras.' };
  }

  const loss = finiteNumber(metrics.fractionLost);
  const rtt = finiteNumber(metrics.roundTripTimeSeconds);
  const jitter = finiteNumber(metrics.jitterSeconds);
  const available = finiteNumber(metrics.availableOutgoingBitrate);
  const bitrate = finiteNumber(metrics.bitrateBps);
  const networkSignals = [
    loss !== null && loss >= 0.03,
    rtt !== null && rtt >= 0.25,
    jitter !== null && jitter >= 0.04,
    available !== null && bitrate !== null && bitrate > 0 && available < bitrate * 0.75,
  ].filter(Boolean).length;

  if (networkSignals >= 2) {
    return { status: 'network', text: 'Os indicadores sugerem possível congestionamento; confirme se RTT, perda ou estimativa de banda continuam ruins.' };
  }

  return { status: 'insufficient', text: 'Ainda não há sinais suficientes para apontar CPU ou rede como causa.' };
}