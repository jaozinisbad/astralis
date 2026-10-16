import { getAdaptiveVideoBitrateAllocations, getVideoEncodingParameters } from './streamQuality.mjs';
import { summarizeWebRtcStats } from './streamStats.mjs';
import { createIceConnectionHealthMonitor } from './iceConnectionHealth.mjs';
import { DEFAULT_ROOM_ICE_SERVERS, loadRoomIceConfiguration } from './roomIceConfiguration.mjs';

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
  iceServers,
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
  const peerNegotiationQueues = new Map();
  const localOfferNegotiations = new Map();
  const remoteOfferNegotiations = new Map();
  let negotiationSequence = 0;
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

  function createNegotiationId() {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
    negotiationSequence += 1;
    return [Date.now().toString(36), negotiationSequence.toString(36), Math.random().toString(36).slice(2)].join('-');
  }

  function readNegotiationId(description) {
    if (description?.negotiationId === undefined) return null;
    if (typeof description.negotiationId !== 'string' || !description.negotiationId || description.negotiationId.length > 128) {
      throw new TypeError('Identificador da negociação WebRTC inválido.');
    }
    return description.negotiationId;
  }

  function signaledDescription(description, negotiationId) {
    return {
      type: description.type,
      sdp: description.sdp,
      ...(negotiationId ? { negotiationId } : {}),
    };
  }

  function isPeerCurrent(peerId, peer) {
    return !closed && peers.get(peerId) === peer;
  }

  function candidateMatchesDescription(candidate, peer) {
    // ICE credentials change when a peer is recreated. A delayed candidate
    // from the old connection must not abort the new SDP/answer exchange.
    const usernameFragment = candidate.usernameFragment
      || /(?:^|\s)ufrag\s+(\S+)/.exec(candidate.candidate || '')?.[1];
    if (!usernameFragment) return true;
    const fragments = [...(peer.remoteDescription?.sdp || '').matchAll(/^a=ice-ufrag:([^\r\n]+)\r?$/gm)]
      .map((match) => match[1]);
    return fragments.length === 0 || fragments.includes(usernameFragment);
  }

  function queueCandidate(peerId, candidate) {
    const waiting = candidatesWaitingForDescription.get(peerId) || [];
    // A different ufrag can arrive before its replacement offer. Retain a
    // bounded queue; applying the next SDP filters obsolete generations.
    if (waiting.length >= 128) waiting.shift();
    waiting.push(candidate);
    candidatesWaitingForDescription.set(peerId, waiting);
  }

  function serializePeerNegotiation(peerId, peer, operation) {
    const previous = peerNegotiationQueues.get(peerId) || Promise.resolve();
    const queued = Promise.resolve(previous)
      .catch(() => {})
      .then(() => {
        if (!isPeerCurrent(peerId, peer)) return;
        return operation();
      })
      .catch((error) => {
        if (!isPeerCurrent(peerId, peer)) return;
        throw error;
      })
      .finally(() => {
        if (peerNegotiationQueues.get(peerId) === queued) peerNegotiationQueues.delete(peerId);
      });
    peerNegotiationQueues.set(peerId, queued);
    return queued;
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
    const peer = new RTCPeerConnectionImpl({ iceServers: iceServers || DEFAULT_ROOM_ICE_SERVERS });
    peers.set(peerId, peer);
    peer.onicecandidate = ({ candidate }) => {
      if (candidate && isPeerCurrent(peerId, peer)) emitSignal('candidate', peerId, candidate);
    };
    peer.ontrack = (event) => {
      if (isPeerCurrent(peerId, peer)) onRemoteStream(peerId, event.streams?.[0] || null);
    };
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

  async function configurePeerIce(peerId, peer) {
    if (!iceServers) {
      const configuredServers = await loadRoomIceConfiguration(socket, roomId);
      if (!isPeerCurrent(peerId, peer)) return false;
      if (typeof peer.setConfiguration === 'function') peer.setConfiguration({ iceServers: configuredServers });
    }
    return isPeerCurrent(peerId, peer);
  }

  async function applyWaitingCandidates(peerId, peer) {
    if (!isPeerCurrent(peerId, peer)) return false;
    const waiting = candidatesWaitingForDescription.get(peerId) || [];
    candidatesWaitingForDescription.delete(peerId);
    for (const candidate of waiting) {
      if (!isPeerCurrent(peerId, peer)) return false;
      if (!candidateMatchesDescription(candidate, peer)) continue;
      await peer.addIceCandidate(candidate);
      if (!isPeerCurrent(peerId, peer)) return false;
    }
    return true;
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
        let negotiation = localOfferNegotiations.get(peerId);
        if (!negotiation || negotiation.peer !== existingPeer) {
          negotiation = { peer: existingPeer, id: createNegotiationId() };
          localOfferNegotiations.set(peerId, negotiation);
        }
        emitSignal('offer', peerId, signaledDescription(existingPeer.localDescription, negotiation.id));
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
          if (!await configurePeerIce(peerId, peer)) return;
          iceMonitorsByPeer.get(peerId)?.start();
          const offer = await peer.createOffer();
          if (!isPeerCurrent(peerId, peer)) return;
          await peer.setLocalDescription(offer);
          if (!isPeerCurrent(peerId, peer)) return;
          const description = peer.localDescription || offer;
          const negotiationId = createNegotiationId();
          localOfferNegotiations.set(peerId, { peer, id: negotiationId });
          emitSignal('offer', peerId, signaledDescription(description, negotiationId));
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
    })().catch((error) => {
      // Closing an old peer can reject its pending WebRTC operation after a
      // restart already installed a replacement. Its callers must not close
      // that replacement while handling the obsolete promise rejection.
      if (connecting.get(peerId) !== connection) return;
      throw error;
    }).finally(() => {
      if (connecting.get(peerId) === connection) connecting.delete(peerId);
    });
    connecting.set(peerId, connection);
    return connection;
  }

  async function receiveOffer(message = {}) {
    if (closed || role !== 'viewer' || message.roomId !== roomId || !message.de || !message.descricao || !matchesSignal(message)) return;
    const peerId = message.de;
    const peer = createPeer(peerId);
    return serializePeerNegotiation(peerId, peer, async () => {
      const description = message.descricao;
      if (description.type !== 'offer' || typeof description.sdp !== 'string' || !description.sdp.trim()) {
        throw new TypeError('Oferta WebRTC inválida.');
      }
      const negotiationId = readNegotiationId(description);
      const previousNegotiation = remoteOfferNegotiations.get(peerId);
      const sameAppliedOffer = peer.remoteDescription?.type === 'offer'
        && peer.remoteDescription.sdp === description.sdp
        && peer.localDescription?.type === 'answer';
      const sameNegotiation = negotiationId
        ? previousNegotiation?.peer === peer && previousNegotiation.id === negotiationId && previousNegotiation.sdp === description.sdp
        : true;
      if (sameAppliedOffer && sameNegotiation) {
        const cachedNegotiationId = negotiationId || previousNegotiation?.id || null;
        emitSignal('answer', peerId, signaledDescription(peer.localDescription, cachedNegotiationId));
        return;
      }
      if (negotiationId && previousNegotiation?.peer === peer && previousNegotiation.id === negotiationId
        && previousNegotiation.sdp !== description.sdp) {
        throw new Error('A mesma identificação WebRTC chegou com ofertas diferentes.');
      }
      if (!await configurePeerIce(peerId, peer)) return;
      iceMonitorsByPeer.get(peerId)?.start();
      await peer.setRemoteDescription({ type: description.type, sdp: description.sdp });
      if (!isPeerCurrent(peerId, peer)) return;
      remoteOfferNegotiations.set(peerId, { peer, id: negotiationId, sdp: description.sdp });
      if (!await applyWaitingCandidates(peerId, peer)) return;
      const answer = await peer.createAnswer();
      if (!isPeerCurrent(peerId, peer)) return;
      await peer.setLocalDescription(answer);
      if (!isPeerCurrent(peerId, peer)) return;
      const answerDescription = peer.localDescription || answer;
      emitSignal('answer', peerId, signaledDescription(answerDescription, negotiationId));
    });
  }

  async function receiveAnswer(message = {}) {
    if (closed || role !== 'host' || message.roomId !== roomId || !message.de || !message.resposta || !matchesSignal(message)) return;
    const peerId = message.de;
    const peer = peers.get(peerId);
    if (!peer) return;
    return serializePeerNegotiation(peerId, peer, async () => {
      const description = message.resposta;
      if (description.type !== 'answer' || typeof description.sdp !== 'string' || !description.sdp.trim()) {
        throw new TypeError('Resposta WebRTC inválida.');
      }
      const negotiationId = readNegotiationId(description);
      const localNegotiation = localOfferNegotiations.get(peerId);
      if (negotiationId && (!localNegotiation || localNegotiation.peer !== peer || localNegotiation.id !== negotiationId)) {
        return;
      }
      if (peer.signalingState === 'stable') {
        if (peer.remoteDescription?.type === 'answer'
          && peer.remoteDescription.sdp === description.sdp
          && (!negotiationId || (localNegotiation?.peer === peer && localNegotiation.id === negotiationId))) {
          return;
        }
        // A structurally valid answer outside have-local-offer belongs to an
        // already-finished or superseded negotiation. Do not surface relay
        // replays as a persistent user-facing signaling error.
        return;
      }
      if (peer.signalingState !== 'have-local-offer' || peer.localDescription?.type !== 'offer') return;
      await peer.setRemoteDescription({ type: description.type, sdp: description.sdp });
      if (!isPeerCurrent(peerId, peer)) return;
      await applyWaitingCandidates(peerId, peer);
    });
  }

  async function receiveCandidate(message = {}) {
    if (closed || message.roomId !== roomId || !message.de || !message.candidato || !matchesSignal(message)) return;
    let peer = peers.get(message.de);
    if (!peer && role === 'viewer') peer = createPeer(message.de);
    if (!peer) return;
    if (!peer.remoteDescription || !candidateMatchesDescription(message.candidato, peer)) {
      queueCandidate(message.de, message.candidato);
      return;
    }
    await peer.addIceCandidate(message.candidato);
  }

  function closePeer(peerId, preserveViewer = false, preserveRecovery = false) {
    clearReconnectTimer(peerId);
    peerNegotiationQueues.delete(peerId);
    localOfferNegotiations.delete(peerId);
    remoteOfferNegotiations.delete(peerId);
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
    if (peer && (message.restart === true || ['disconnected', 'failed', 'closed'].includes(peer.connectionState))) {
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
