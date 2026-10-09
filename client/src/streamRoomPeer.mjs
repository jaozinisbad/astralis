import { getAdaptiveVideoBitrateAllocations, getVideoEncodingParameters } from './streamQuality.mjs';
import { summarizeWebRtcStats } from './streamStats.mjs';
import { createIceConnectionHealthMonitor } from './iceConnectionHealth.mjs';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createStreamRoomPeerSession({
  socket,
  roomId,
  role,
  streamId,
  quality = {},
  onRemoteStream = () => {},
  onStats = () => {},
  onQualityError = () => {},
  onSignalError = () => {},
  onIceFailure = () => {},
  onPeerConnectionFailed = () => {},
  iceConnectionTimeoutMs = 20_000,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  reconnectDelayMs = 1_500,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  statsIntervalMs = 2_000,
  statsEstimateTtlMs = Math.max(5_000, Math.max(1_000, statsIntervalMs) * 3),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const peers = new Map();
  const connecting = new Map();
  const candidatesWaitingForDescription = new Map();
  const reconnectTimers = new Map();
  const reconnectTimerResolvers = new Map();
  const iceMonitorsByPeer = new Map();
  const iceHealthByPeer = new Map();
  const recoveryAttemptsByPeer = new Map();
  const recoveryFailureDetailsByPeer = new Map();
  const recoveryForceByPeer = new Map();
  const terminalRecoveryReportedByPeer = new Set();
  const viewers = new Set();
  const maxPeerRecoveryAttempts = 2;
  const availableOutgoingByPeer = new Map();
  const availableOutgoingSampledAtByPeer = new Map();
  const adaptiveCapacityByPeer = new Map();
  const bandwidthPressureSamplesByPeer = new Map();
  const bandwidthHeadroomSamplesByPeer = new Map();
  const allocatedBitrateByPeer = new Map();
  const allocatedDegradationPreferenceByPeer = new Map();
  const previousStatsByPeer = new Map();
  const peerStatsByPeer = new Map();
  let localStream = null;
  let currentQuality = quality;
  let closed = false;
  let collectingStats = false;
  let bitrateUpdatePromise = null;
  let bitrateUpdateQueued = false;

  if (!socket || !roomId || (role !== 'host' && role !== 'viewer')) {
    throw new TypeError('Socket, sala e papel válido são necessários para transmitir.');
  }
  if (!RTCPeerConnectionImpl) throw new Error('Este navegador não oferece suporte a WebRTC.');

  function emitSignal(type, peerId, payload) {
    if (closed || !peerId) return;
    const field = type === 'offer' ? 'descricao' : type === 'answer' ? 'resposta' : 'candidato';
    const event = `sala:sinal:${type === 'offer' ? 'oferta' : type === 'answer' ? 'resposta' : 'candidato'}`;
    try {
      socket.emit(event, {
        roomId,
        para: peerId,
        ...(streamId ? { streamId } : {}),
        [field]: payload,
      }, (result) => {
        if (result?.ok === false) {
          try {
            onSignalError({ type, peerId, phase: 'send', error: result.error || 'O servidor recusou a sinalização.' });
          } catch {}
        }
      });
    } catch (error) {
      try { onSignalError({ type, peerId, phase: 'send', error }); } catch {}
    }
  }

  function handleSignal(type, handler) {
    return (message = {}) => Promise.resolve(handler(message)).catch((error) => {
      try { onSignalError({ type, peerId: message.de || null, phase: 'receive', error }); } catch {}
    });
  }

  function matchesSignal(message) {
    if (message.streamId !== undefined) {
      return message.streamId === streamId && (role !== 'viewer' || !streamId || message.de === streamId);
    }
    // The previous server relayed signals without a streamId. The sender
    // identifies a viewer's presenter; hosts only accept existing peers.
    if (!streamId) return true;
    return role === 'viewer' ? message.de === streamId : peers.has(message.de);
  }

  function clearReconnectTimer(peerId) {
    const timer = reconnectTimers.get(peerId);
    if (timer !== undefined) clearTimeoutImpl(timer);
    reconnectTimers.delete(peerId);
    recoveryForceByPeer.delete(peerId);
    const resolveRetry = reconnectTimerResolvers.get(peerId);
    if (resolveRetry) resolveRetry();
  }

  function retryPeer(peerId, peer, failureDetails = {}) {
    if (closed || peers.get(peerId) !== peer) return;
    const attempts = recoveryAttemptsByPeer.get(peerId) || 0;
    if (attempts >= maxPeerRecoveryAttempts) {
      if (terminalRecoveryReportedByPeer.has(peerId)) return;
      terminalRecoveryReportedByPeer.add(peerId);
      try {
        onIceFailure(peerId, {
          ...failureDetails,
          ...(iceHealthByPeer.get(peerId) || {}),
          terminal: true,
          attempts,
          retries: attempts,
        });
      } catch {}
      return;
    }
    const nextAttempt = attempts + 1;
    recoveryAttemptsByPeer.set(peerId, nextAttempt);
    if (role === 'host') {
      closePeer(peerId, true, true);
      if (localStream && viewers.has(peerId)) connectViewer(peerId).catch(() => closePeer(peerId, true));
      return;
    }
    closePeer(peerId, false, true);
    try { onPeerConnectionFailed(peerId, { ...failureDetails, terminal: false, attempts: nextAttempt }); } catch {}
  }

  function schedulePeerRecovery(peerId, peer, force = false, failureDetails = null) {
    if (closed || terminalRecoveryReportedByPeer.has(peerId)) return;
    if (failureDetails) recoveryFailureDetailsByPeer.set(peerId, failureDetails);
    if (force) recoveryForceByPeer.set(peerId, true);
    if (reconnectTimers.has(peerId)) return;
    const timer = setTimeoutImpl(() => {
      reconnectTimers.delete(peerId);
      const details = recoveryFailureDetailsByPeer.get(peerId) || {};
      const shouldForce = recoveryForceByPeer.get(peerId) || false;
      recoveryForceByPeer.delete(peerId);
      recoveryFailureDetailsByPeer.delete(peerId);
      if (closed || peers.get(peerId) !== peer || (!shouldForce && !['disconnected', 'failed'].includes(peer.connectionState))) return;
      retryPeer(peerId, peer, details);
    }, reconnectDelayMs);
    reconnectTimers.set(peerId, timer);
  }

  function waitForQualityRetry(peerId) {
    return new Promise((resolve) => {
      const finish = () => {
        if (reconnectTimerResolvers.get(peerId) !== finish) return;
        reconnectTimerResolvers.delete(peerId);
        reconnectTimers.delete(peerId);
        resolve();
      };
      const timer = setTimeoutImpl(finish, reconnectDelayMs);
      reconnectTimers.set(peerId, timer);
      reconnectTimerResolvers.set(peerId, finish);
    });
  }

  function createPeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);
    const peer = new RTCPeerConnectionImpl({ iceServers: ICE_SERVERS });
    peers.set(peerId, peer);
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) emitSignal('candidate', peerId, candidate);
    };
    peer.ontrack = (event) => onRemoteStream(peerId, event.streams?.[0] || null);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        clearReconnectTimer(peerId);
        terminalRecoveryReportedByPeer.delete(peerId);
        recoveryAttemptsByPeer.delete(peerId);
        recoveryFailureDetailsByPeer.delete(peerId);
        collectPeerStats().catch(() => {});
      } else if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        schedulePeerRecovery(peerId, peer);
      } else if (peer.connectionState === 'closed') {
        clearReconnectTimer(peerId);
        if (peers.get(peerId) === peer) closePeer(peerId, role === 'host');
      }
      publishDiagnostics();
    };
    const iceMonitor = createIceConnectionHealthMonitor({
      peer,
      timeoutMs: iceConnectionTimeoutMs,
      onStatus: (snapshot) => { iceHealthByPeer.set(peerId, snapshot); publishDiagnostics(); },
      onFailure: (failure) => schedulePeerRecovery(peerId, peer, true, failure),
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    iceMonitorsByPeer.set(peerId, iceMonitor);
    return peer;
  }

  async function applyWaitingCandidates(peerId, peer) {
    const waiting = candidatesWaitingForDescription.get(peerId) || [];
    candidatesWaitingForDescription.delete(peerId);
    for (const candidate of waiting) await peer.addIceCandidate(candidate);
  }

  function publishDiagnostics() {
    if (closed) return;
    const peerIds = role === 'host' ? [...viewers] : [...peers.keys()];
    const diagnostics = peerIds.map((peerId) => ({
      peerId,
      connectionState: peers.get(peerId)?.connectionState || 'connecting',
      ice: iceHealthByPeer.get(peerId) ?? null,
      targetVideoBitrate: allocatedBitrateByPeer.get(peerId) ?? null,
      availableOutgoingBitrate: availableOutgoingByPeer.get(peerId) ?? null,
      metrics: peerStatsByPeer.get(peerId) ?? null,
    }));
    try {
      onStats({
        role,
        videoBudget: currentQuality.bitrate ?? null,
        adaptiveQuality: Boolean(currentQuality.adaptiveQuality),
        peers: diagnostics,
      });
    } catch {}
  }

  async function applyVideoBitrateUpdate() {
    if (closed || role !== 'host') return { success: true, blockedPeerIds: new Set() };
    const peerIds = [...viewers];
    const allocations = getAdaptiveVideoBitrateAllocations(currentQuality, peerIds, adaptiveCapacityByPeer);
    const degradationPreference = getVideoEncodingParameters(currentQuality, peerIds.length).degradationPreference;
    const updates = [];
    let allSucceeded = true;
    let reductionFailed = false;
    const blockedPeerIds = new Set();

    for (const [peerId, peer] of peers.entries()) {
      const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
      const bitrate = allocations.get(peerId);
      if (!sender || !Number.isFinite(bitrate)) continue;

      try {
        const parameters = sender.getParameters();
        const currentEncoding = parameters.encodings?.[0] || {};
        const previousBitrate = allocatedBitrateByPeer.has(peerId)
          ? allocatedBitrateByPeer.get(peerId)
          : Number.isFinite(currentEncoding.maxBitrate) ? currentEncoding.maxBitrate : null;
        const previousPreference = allocatedDegradationPreferenceByPeer.get(peerId)
          ?? parameters.degradationPreference
          ?? null;
        const isIncrease = previousBitrate !== null && bitrate > previousBitrate;
        const needsBitrateUpdate = previousBitrate === null || bitrate !== previousBitrate;
        const needsPreferenceUpdate = degradationPreference !== previousPreference;

        if (!needsBitrateUpdate && !needsPreferenceUpdate) continue;
        updates.push({
          peerId,
          peer,
          sender,
          parameters,
          bitrate,
          isIncrease,
          needsBitrateUpdate,
          needsPreferenceUpdate,
          hasPriorCap: previousBitrate !== null,
        });
      } catch (error) {
        allSucceeded = false;
        reductionFailed = true;
        blockedPeerIds.add(peerId);
        try { onQualityError(error); } catch {}
      }
    }

    // Restrictive cap changes run first. An unset cap is treated as restrictive:
    // new senders must receive a ceiling before an offer can start media.
    updates.sort((left, right) => Number(left.isIncrease) - Number(right.isIncrease)
      || left.bitrate - right.bitrate);

    for (const update of updates) {
      if (closed || peers.get(update.peerId) !== update.peer) continue;
      if ((update.isIncrease || (!update.hasPriorCap && update.needsBitrateUpdate)) && reductionFailed) {
        allSucceeded = false;
        blockedPeerIds.add(update.peerId);
        continue;
      }

      const parameters = update.parameters;
      parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((encoding) => ({
        ...encoding,
        maxBitrate: update.bitrate,
      }));
      parameters.degradationPreference = degradationPreference;
      try {
        await update.sender.setParameters(parameters);
        if (closed || peers.get(update.peerId) !== update.peer) continue;
        allocatedBitrateByPeer.set(update.peerId, update.bitrate);
        allocatedDegradationPreferenceByPeer.set(update.peerId, degradationPreference);
      } catch (error) {
        allSucceeded = false;
        blockedPeerIds.add(update.peerId);
        try { onQualityError(error); } catch {}
        if (!update.isIncrease && update.needsBitrateUpdate) reductionFailed = true;
      }
    }

    let aggregateBudgetSafe = true;
    if (currentQuality.adaptiveQuality) {
      const aggregateBudget = getVideoEncodingParameters(currentQuality, 1).maxBitrate;
      let allocatedTotal = 0;
      for (const peerId of peerIds) {
        const peer = peers.get(peerId);
        if (!peer) {
          aggregateBudgetSafe = false;
          continue;
        }
        const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
        if (!sender) continue;
        let appliedCap = allocatedBitrateByPeer.get(peerId);
        if (!Number.isFinite(appliedCap)) {
          try { appliedCap = sender.getParameters().encodings?.[0]?.maxBitrate; } catch {}
        }
        if (!Number.isFinite(appliedCap)) {
          aggregateBudgetSafe = false;
          continue;
        }
        allocatedTotal += appliedCap;
      }
      if (allocatedTotal > aggregateBudget) aggregateBudgetSafe = false;
    }

    if (reductionFailed || !aggregateBudgetSafe) {
      // A failed reduction or a still-over-budget set of applied caps must
      // block every peer that has not sent an offer yet, even when its own cap
      // was successfully applied during an earlier retry.
      for (const peerId of viewers) {
        const peer = peers.get(peerId);
        if (peer && peer.localDescription?.type !== 'offer') blockedPeerIds.add(peerId);
      }
      updates.forEach((update) => {
        if (update.isIncrease) blockedPeerIds.add(update.peerId);
      });
      allSucceeded = false;
    }

    publishDiagnostics();
    return { success: allSucceeded, blockedPeerIds };
  }

  function updateVideoBitrates() {
    if (closed || role !== 'host') return Promise.resolve({ success: true, blockedPeerIds: new Set() });
    bitrateUpdateQueued = true;
    if (!bitrateUpdatePromise) {
      let resolveCurrent;
      let rejectCurrent;
      const currentPromise = new Promise((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
      });
      bitrateUpdatePromise = currentPromise;

      const finish = (error, result) => {
        if (bitrateUpdatePromise === currentPromise) bitrateUpdatePromise = null;
        // There is no await between the runner's final queue check and this
        // handoff. Still drain defensively if a reentrant callback queued work.
        if (bitrateUpdateQueued && !closed) {
          updateVideoBitrates().then(resolveCurrent, rejectCurrent);
        } else if (error) {
          rejectCurrent(error);
        } else {
          resolveCurrent(result);
        }
      };

      (async () => {
        let result = { success: true, blockedPeerIds: new Set() };
        try {
          while (bitrateUpdateQueued && !closed) {
            bitrateUpdateQueued = false;
            result = await applyVideoBitrateUpdate();
          }
          finish(null, result);
        } catch (error) {
          finish(error, false);
        }
      })();
    }
    return bitrateUpdatePromise;
  }

  function expireStaleOutgoingEstimates(now = Date.now()) {
    for (const [peerId, sampledAt] of availableOutgoingSampledAtByPeer) {
      if (now - sampledAt <= statsEstimateTtlMs) continue;
      availableOutgoingSampledAtByPeer.delete(peerId);
      availableOutgoingByPeer.delete(peerId);
      adaptiveCapacityByPeer.delete(peerId);
      bandwidthPressureSamplesByPeer.delete(peerId);
      bandwidthHeadroomSamplesByPeer.delete(peerId);
    }
  }

  async function collectPeerStats() {
    if (closed || collectingStats || peers.size === 0) return;
    collectingStats = true;
    try {
      await Promise.all([...peers.entries()].map(async ([peerId, peer]) => {
        if (peer.connectionState !== 'connected' || typeof peer.getStats !== 'function') return;
        let report;
        try {
          report = await peer.getStats();
        } catch {
          return;
        }
        if (closed || peers.get(peerId) !== peer) return;

        const { metrics, counters } = summarizeWebRtcStats(report, previousStatsByPeer.get(peerId));
        if (!metrics.direction) return;
        previousStatsByPeer.set(peerId, counters);
        peerStatsByPeer.set(peerId, { ...metrics, sampledAt: Date.now() });

        if (role === 'host' && Number.isFinite(metrics.availableOutgoingBitrate)
          && metrics.availableOutgoingBitrate >= 0) {
          const previous = availableOutgoingByPeer.get(peerId);
          const alpha = previous === undefined || metrics.availableOutgoingBitrate < previous ? 0.6 : 0.25;
          const estimate = Math.round(previous === undefined
            ? metrics.availableOutgoingBitrate
            : previous * (1 - alpha) + metrics.availableOutgoingBitrate * alpha);
          availableOutgoingByPeer.set(peerId, estimate);
          availableOutgoingSampledAtByPeer.set(peerId, Date.now());

          // availableOutgoingBitrate is cold-started and can be far below the
          // real path capacity. Use it as an allocation ceiling only after the
          // sender consistently reports bandwidth limitation and the estimate
          // has stopped recovering. This avoids locking a healthy stream to its
          // initial probe result.
          const appliedCap = allocatedBitrateByPeer.get(peerId)
            ?? getVideoEncodingParameters(currentQuality, Math.max(1, viewers.size)).maxBitrate;
          const estimateIsLow = estimate < appliedCap * 0.85;
          const estimateIsRecovering = previous !== undefined && estimate > previous * 1.12;
          const sustainedBandwidthPressure = currentQuality.adaptiveQuality
            && metrics.qualityLimitationReason === 'bandwidth'
            && estimateIsLow
            && !estimateIsRecovering;
          const pressureSamples = sustainedBandwidthPressure
            ? (bandwidthPressureSamplesByPeer.get(peerId) || 0) + 1
            : 0;
          bandwidthPressureSamplesByPeer.set(peerId, pressureSamples);
          if (pressureSamples >= 2) {
            const priorCapacity = adaptiveCapacityByPeer.get(peerId);
            if (!Number.isFinite(priorCapacity) || estimate < priorCapacity) adaptiveCapacityByPeer.set(peerId, estimate);
          }

          if (currentQuality.adaptiveQuality && !adaptiveCapacityByPeer.has(peerId)) {
            const equalShare = getVideoEncodingParameters(currentQuality, Math.max(1, viewers.size)).maxBitrate;
            const hasStableHeadroom = estimate > equalShare * 1.25
              && !estimateIsRecovering
              && metrics.qualityLimitationReason !== 'cpu';
            const headroomSamples = hasStableHeadroom
              ? (bandwidthHeadroomSamplesByPeer.get(peerId) || 0) + 1
              : 0;
            bandwidthHeadroomSamplesByPeer.set(peerId, headroomSamples);
            if (headroomSamples >= 2) adaptiveCapacityByPeer.set(peerId, estimate);
          }

          const confirmedCapacity = adaptiveCapacityByPeer.get(peerId);
          if (currentQuality.adaptiveQuality && Number.isFinite(confirmedCapacity)
            && metrics.qualityLimitationReason !== 'cpu'
            && estimate > confirmedCapacity * 1.25) {
            const headroomSamples = (bandwidthHeadroomSamplesByPeer.get(peerId) || 0) + 1;
            bandwidthHeadroomSamplesByPeer.set(peerId, headroomSamples);
            if (headroomSamples >= 6) {
              const step = Math.max(100_000, Math.floor(confirmedCapacity * 0.15));
              adaptiveCapacityByPeer.set(peerId, Math.min(estimate, confirmedCapacity + step));
              bandwidthHeadroomSamplesByPeer.set(peerId, 0);
            }
          } else if (adaptiveCapacityByPeer.has(peerId)) {
            bandwidthHeadroomSamplesByPeer.set(peerId, 0);
          }
        } else if (role === 'host') {
          bandwidthPressureSamplesByPeer.delete(peerId);
          bandwidthHeadroomSamplesByPeer.delete(peerId);
        }
      }));

      expireStaleOutgoingEstimates();
      if (role === 'host' && currentQuality.adaptiveQuality) await updateVideoBitrates();
      publishDiagnostics();
    } finally {
      collectingStats = false;
    }
  }
  function connectViewer(peerId) {
    if (closed || role !== 'host' || !localStream || !peerId) return Promise.resolve();
    viewers.add(peerId);
    if (connecting.has(peerId)) return connecting.get(peerId);
    const existingPeer = peers.get(peerId);
    if (existingPeer) {
      // A viewer may announce readiness after the first offer was sent but before
      // it registered its listener. Re-send the same pending offer, never create
      // a second offer on the same RTCPeerConnection.
      if (!existingPeer.remoteDescription && existingPeer.localDescription?.type === 'offer') {
        emitSignal('offer', peerId, existingPeer.localDescription);
      }
      return Promise.resolve();
    }
    const connection = (async () => {
      const peer = createPeer(peerId);
      if (!peer.getSenders().some((sender) => sender.track && localStream.getTracks().includes(sender.track))) {
        localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));
      }
      let attempts = 0;
      while (!closed && peers.get(peerId) === peer && localStream && viewers.has(peerId)) {
        const qualityResult = await updateVideoBitrates();
        if (closed || peers.get(peerId) !== peer) return;
        if (!qualityResult.blockedPeerIds.has(peerId)) {
          if (['disconnected', 'failed'].includes(peer.connectionState)) {
            schedulePeerRecovery(peerId, peer);
            return;
          }
          iceMonitorsByPeer.get(peerId)?.start();
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          emitSignal('offer', peerId, peer.localDescription || offer);
          return;
        }
        attempts += 1;
        if (attempts >= 3) {
          try { onQualityError(new Error('Não foi possível aplicar o limite de vídeo desta conexão após três tentativas.')); } catch {}
          closePeer(peerId);
          return;
        }
        await waitForQualityRetry(peerId);
      }
    })().finally(() => connecting.delete(peerId));
    connecting.set(peerId, connection);
    return connection;
  }

  async function receiveOffer(message = {}) {
    if (closed || role !== 'viewer' || message.roomId !== roomId || !message.de || !message.descricao || !matchesSignal(message)) return;
    const peer = createPeer(message.de);
    if (peer.remoteDescription?.sdp === message.descricao.sdp && peer.localDescription?.type === 'answer') {
      // The presenter can retry an offer if our first answer was lost. Re-send
      // the existing answer rather than applying the same offer twice.
      emitSignal('answer', message.de, peer.localDescription);
      return;
    }
    iceMonitorsByPeer.get(message.de)?.start();
    await peer.setRemoteDescription(message.descricao);
    await applyWaitingCandidates(message.de, peer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    emitSignal('answer', message.de, peer.localDescription || answer);
  }

  async function receiveAnswer(message = {}) {
    if (closed || role !== 'host' || message.roomId !== roomId || !message.de || !message.resposta || !matchesSignal(message)) return;
    const peer = peers.get(message.de);
    if (!peer) return;
    await peer.setRemoteDescription(message.resposta);
    await applyWaitingCandidates(message.de, peer);
  }

  async function receiveCandidate(message = {}) {
    if (closed || message.roomId !== roomId || !message.de || !message.candidato || !matchesSignal(message)) return;
    let peer = peers.get(message.de);
    if (!peer && role === 'viewer') peer = createPeer(message.de);
    if (!peer) return;
    if (!peer.remoteDescription) {
      const waiting = candidatesWaitingForDescription.get(message.de) || [];
      waiting.push(message.candidato);
      candidatesWaitingForDescription.set(message.de, waiting);
      return;
    }
    await peer.addIceCandidate(message.candidato);
  }

  function closePeer(peerId, preserveViewer = false, preserveRecovery = false) {
    clearReconnectTimer(peerId);
    const iceMonitor = iceMonitorsByPeer.get(peerId);
    iceMonitor?.close();
    iceMonitorsByPeer.delete(peerId);
    iceHealthByPeer.delete(peerId);
    recoveryFailureDetailsByPeer.delete(peerId);
    if (!preserveRecovery) {
      recoveryAttemptsByPeer.delete(peerId);
      terminalRecoveryReportedByPeer.delete(peerId);
    }
    if (!preserveViewer) viewers.delete(peerId);
    const peer = peers.get(peerId);
    previousStatsByPeer.delete(peerId);
    peerStatsByPeer.delete(peerId);
    availableOutgoingByPeer.delete(peerId);
    availableOutgoingSampledAtByPeer.delete(peerId);
    adaptiveCapacityByPeer.delete(peerId);
    bandwidthPressureSamplesByPeer.delete(peerId);
    bandwidthHeadroomSamplesByPeer.delete(peerId);
    allocatedBitrateByPeer.delete(peerId);
    allocatedDegradationPreferenceByPeer.delete(peerId);
    if (!peer) {
      if (role === 'host') updateVideoBitrates().catch(() => {});
      publishDiagnostics();
      return;
    }
    peers.delete(peerId);
    candidatesWaitingForDescription.delete(peerId);
    connecting.delete(peerId);
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.close();
    onRemoteStream(peerId, null);
    if (role === 'host') updateVideoBitrates().catch(() => {});
    publishDiagnostics();
  }
  function onViewerJoined(message = {}) {
    if (role !== 'host' || message.salaId !== roomId || !message.socketId
      || (message.streamId !== undefined && message.streamId !== streamId)) return;
    viewers.add(message.socketId);
    const peer = peers.get(message.socketId);
    if (peer && ['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
      closePeer(message.socketId, true);
    }
    if (localStream) connectViewer(message.socketId).catch(() => closePeer(message.socketId));
  }

  function onViewerLeft(message = {}) {
    if (message.salaId === roomId && message.socketId) closePeer(message.socketId);
  }

  function setViewers(peerSocketIds = []) {
    if (role !== 'host') return Promise.resolve();
    const nextViewers = new Set(peerSocketIds.filter((peerId) => typeof peerId === 'string' && peerId && peerId !== socket.id));
    [...viewers].forEach((peerId) => {
      if (!nextViewers.has(peerId)) closePeer(peerId);
    });
    nextViewers.forEach((peerId) => viewers.add(peerId));
    if (!localStream) return Promise.resolve();
    return Promise.all([...nextViewers].map((peerId) => connectViewer(peerId).catch(() => closePeer(peerId))));
  }

  function resetPeers() {
    [...peers.keys()].forEach((peerId) => closePeer(peerId));
  }

  const listeners = [
    ['sala:sinal:oferta', handleSignal('offer', receiveOffer)],
    ['sala:sinal:resposta', handleSignal('answer', receiveAnswer)],
    ['sala:sinal:candidato', handleSignal('candidate', receiveCandidate)],
    ['sala:espectador-entrou', onViewerJoined],
    ['sala:espectador-saiu', onViewerLeft],
  ];
  listeners.forEach(([event, listener]) => socket.on(event, listener));
  const statsTimer = setIntervalImpl(() => collectPeerStats().catch(() => {}), Math.max(1_000, statsIntervalMs));
  statsTimer?.unref?.();

  return {
    setLocalStream(stream) {
      localStream = stream;
      if (role !== 'host') return;
      if (!stream) {
        [...peers.keys()].forEach((peerId) => closePeer(peerId, true));
        return;
      }
      [...viewers].forEach((peerId) => connectViewer(peerId).catch(() => closePeer(peerId)));
    },
    setViewers,
    resetPeers,
    setQuality(nextQuality = {}) {
      currentQuality = nextQuality;
      if (!currentQuality.adaptiveQuality) {
        adaptiveCapacityByPeer.clear();
        bandwidthPressureSamplesByPeer.clear();
        bandwidthHeadroomSamplesByPeer.clear();
      }
      if (role === 'host') return updateVideoBitrates();
      return Promise.resolve(true);
    },
    closePeer,
    close() {
      if (closed) return;
      closed = true;
      clearIntervalImpl(statsTimer);
      listeners.forEach(([event, listener]) => socket.off(event, listener));
      [...peers.keys()].forEach(closePeer);
      viewers.clear();
      connecting.clear();
      candidatesWaitingForDescription.clear();
      reconnectTimers.forEach((timer) => clearTimeoutImpl(timer));
      reconnectTimers.clear();
      recoveryFailureDetailsByPeer.clear();
      recoveryForceByPeer.clear();
      recoveryAttemptsByPeer.clear();
      terminalRecoveryReportedByPeer.clear();
      iceMonitorsByPeer.clear();
      iceHealthByPeer.clear();
      localStream = null;
      availableOutgoingByPeer.clear();
      availableOutgoingSampledAtByPeer.clear();
      adaptiveCapacityByPeer.clear();
      bandwidthPressureSamplesByPeer.clear();
      bandwidthHeadroomSamplesByPeer.clear();
      allocatedBitrateByPeer.clear();
      allocatedDegradationPreferenceByPeer.clear();
      previousStatsByPeer.clear();
      peerStatsByPeer.clear();
    },
    refreshStats: collectPeerStats,
    getPeerCount: () => peers.size,
  };
}
