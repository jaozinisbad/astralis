export const DEFAULT_ICE_CONNECTION_TIMEOUT_MS = 20_000;

const ICE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const ICE_STATES = new Set(['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']);
const GATHERING_STATES = new Set(['new', 'gathering', 'complete']);
const CONNECTION_STATES = new Set(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);
const EVENT_PROPERTIES = Object.freeze({
  iceconnectionstatechange: 'oniceconnectionstatechange',
  icegatheringstatechange: 'onicegatheringstatechange',
  connectionstatechange: 'onconnectionstatechange',
  icecandidate: 'onicecandidate',
  icecandidateerror: 'onicecandidateerror',
});

function readEnum(value, allowed) {
  return allowed.has(value) ? value : 'unknown';
}

function makeNow(nowImpl) {
  return () => {
    try {
      const value = Number(nowImpl());
      if (Number.isFinite(value)) return value;
    } catch {}
    return Date.now();
  };
}

function attachEvent(peer, type, listener, removers) {
  if (typeof peer.addEventListener === 'function' && typeof peer.removeEventListener === 'function') {
    peer.addEventListener(type, listener);
    removers.push(() => peer.removeEventListener(type, listener));
    return;
  }

  const property = EVENT_PROPERTIES[type];
  if (!property) return;
  const previous = peer[property];
  const wrapped = function wrappedPeerEvent(event) {
    try {
      if (typeof previous === 'function') previous.call(this, event);
    } finally {
      listener(event);
    }
  };
  try {
    peer[property] = wrapped;
    removers.push(() => {
      if (peer[property] === wrapped) peer[property] = previous;
    });
  } catch {}
}

export function createIceConnectionHealthMonitor({
  peer,
  timeoutMs = DEFAULT_ICE_CONNECTION_TIMEOUT_MS,
  onStatus = () => {},
  onFailure = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
} = {}) {
  if (!peer || typeof peer !== 'object') {
    throw new TypeError('Uma RTCPeerConnection é necessária para monitorar o ICE.');
  }

  const configuredTimeout = typeof timeoutMs === 'number' ? timeoutMs : Number.NaN;
  const safeTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
    ? configuredTimeout
    : DEFAULT_ICE_CONNECTION_TIMEOUT_MS;
  const now = makeNow(nowImpl);
  const candidateCounts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  const removers = [];
  let candidateErrorCount = 0;
  let lastCandidateErrorCode = null;
  let timeoutHandle = null;
  let attemptStartedAt = null;
  let started = false;
  let established = false;
  let failureReported = false;
  let closed = false;

  function getSnapshot() {
    return {
      connectionState: readEnum(peer.connectionState, CONNECTION_STATES),
      iceConnectionState: readEnum(peer.iceConnectionState, ICE_STATES),
      iceGatheringState: readEnum(peer.iceGatheringState, GATHERING_STATES),
      candidateCounts: { ...candidateCounts },
      candidateErrorCount,
      lastCandidateErrorCode,
    };
  }

  function publishStatus() {
    if (closed) return;
    try { onStatus(getSnapshot()); } catch {}
  }

  function clearTimeout() {
    if (timeoutHandle === null) return;
    const handle = timeoutHandle;
    timeoutHandle = null;
    try { clearTimeoutImpl(handle); } catch {}
  }

  function reportFailure(reason, snapshot = getSnapshot()) {
    if (closed || failureReported) return;
    failureReported = true;
    clearTimeout();
    const currentTime = now();
    const elapsedMs = attemptStartedAt === null ? null : Math.max(0, currentTime - attemptStartedAt);
    try {
      onFailure({
        reason,
        timeoutMs: safeTimeoutMs,
        elapsedMs,
        ...snapshot,
      });
    } catch {}
  }

  function isEstablished(snapshot) {
    if (snapshot.connectionState !== 'unknown') {
      return snapshot.connectionState === 'connected';
    }
    return snapshot.iceConnectionState === 'connected'
      || snapshot.iceConnectionState === 'completed';
  }

  function observeState() {
    if (closed) return;
    const snapshot = getSnapshot();
    publishStatus();

    if (started && snapshot.iceConnectionState === 'failed') {
      reportFailure('ice-failed', snapshot);
      return;
    }
    if (started && snapshot.connectionState === 'failed') {
      reportFailure('connection-failed', snapshot);
      return;
    }
    if (snapshot.connectionState === 'closed' || snapshot.iceConnectionState === 'closed') {
      clearTimeout();
      return;
    }
    if (isEstablished(snapshot)) {
      established = true;
      clearTimeout();
      return;
    }

    if (!started || established || timeoutHandle !== null || failureReported) return;
    timeoutHandle = setTimeoutImpl(() => {
      timeoutHandle = null;
      if (closed || failureReported) return;
      const latest = getSnapshot();
      if (latest.iceConnectionState === 'failed') {
        reportFailure('ice-failed', latest);
      } else if (latest.connectionState === 'failed') {
        reportFailure('connection-failed', latest);
      } else if (latest.connectionState === 'closed' || latest.iceConnectionState === 'closed') {
        return;
      } else if (isEstablished(latest)) {
        established = true;
      } else {
        reportFailure('timeout', latest);
      }
    }, safeTimeoutMs);
  }

  function onIceCandidate(event = {}) {
    if (closed) return;
    const type = event.candidate?.type;
    if (ICE_TYPES.has(type)) candidateCounts[type] += 1;
    publishStatus();
  }

  function onIceCandidateError(event = {}) {
    if (closed) return;
    candidateErrorCount += 1;
    const code = Number(event.errorCode);
    lastCandidateErrorCode = Number.isInteger(code) && code >= 0 && code <= 65_535 ? code : null;
    publishStatus();
  }

  attachEvent(peer, 'iceconnectionstatechange', observeState, removers);
  attachEvent(peer, 'icegatheringstatechange', observeState, removers);
  attachEvent(peer, 'connectionstatechange', observeState, removers);
  attachEvent(peer, 'icecandidate', onIceCandidate, removers);
  attachEvent(peer, 'icecandidateerror', onIceCandidateError, removers);

  observeState();

  return {
    getSnapshot,
    start() {
      if (closed || started) return getSnapshot();
      started = true;
      attemptStartedAt = now();
      observeState();
      return getSnapshot();
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout();
      removers.splice(0).forEach((remove) => {
        try { remove(); } catch {}
      });
    },
  };
}