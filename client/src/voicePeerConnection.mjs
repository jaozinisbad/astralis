const MAX_RESTARTS = 3;
const RESTART_DELAYS = [2_500, 7_000, 10_000, 12_000];

// Maintain one offer/answer queue per peer, including ICE restarts and screen changes.
export function createVoicePeerConnection({
  peer, polite, prepare, emit, onStatus, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let operations = Promise.resolve();
  let closed = false;
  let pendingOffer = false;
  let attempts = 0;
  let timer = null;
  let initialTimer = false;
  let established = false;
  let status = 'connecting';
  let nextOfferId = 1;
  let localOfferId = null;
  let candidates = [];

  function enqueue(run) {
    operations = operations.then(async () => {
      if (!closed) await run();
    }).catch(() => {
      if (!closed) scheduleRecovery();
    });
    return operations;
  }

  function setStatus(value) {
    if (value === status) return;
    status = value;
    onStatus(value);
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    initialTimer = false;
  }

  function connected() {
    return (peer.connectionState === 'connected'
      && !['failed', 'disconnected'].includes(peer.iceConnectionState))
      || (!peer.connectionState && ['connected', 'completed'].includes(peer.iceConnectionState));
  }

  function scheduleRecovery({ initial = false } = {}) {
    if (closed || timer !== null) return;
    initialTimer = initial;
    timer = setTimer(() => {
      timer = null;
      initialTimer = false;
      void enqueue(async () => {
        if (connected()) return observe();
        if (attempts >= MAX_RESTARTS) return setStatus('failed');
        attempts++;
        setStatus('reconnecting');
        scheduleRecovery();
        // A lost answer must not leave later attempts queued indefinitely.
        if (peer.signalingState === 'have-local-offer') {
          await peer.setLocalDescription({ type: 'rollback' });
        }
        await sendOffer(true);
      });
    }, initial ? 20_000 : RESTART_DELAYS[attempts]);
  }

  function observe() {
    if (closed) return;
    if (connected()) {
      established = true;
      attempts = 0;
      cancelTimer();
      setStatus('connected');
    } else if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed'
      || peer.connectionState === 'disconnected' || peer.iceConnectionState === 'disconnected') {
      if (attempts >= MAX_RESTARTS && timer === null) return;
      setStatus('reconnecting');
      if (initialTimer) cancelTimer();
      scheduleRecovery();
    } else if (!established && status !== 'failed') {
      scheduleRecovery({ initial: true });
    }
  }

  async function sendOffer(restart = false) {
    if (peer.signalingState !== 'stable') {
      pendingOffer = true;
      return;
    }
    await prepare({ offer: true, restart });
    if (closed) return;
    pendingOffer = false;
    const description = await peer.createOffer(restart ? { iceRestart: true } : undefined);
    if (closed) return;
    await peer.setLocalDescription(description);
    if (closed) return;
    localOfferId = nextOfferId++;
    emit('webrtc-oferta', 'oferta', { type: description.type, sdp: description.sdp, idOferta: localOfferId });
    observe();
  }

  function matchesRemote(candidate) {
    const sdp = peer.remoteDescription?.sdp;
    return Boolean(sdp) && (!candidate.usernameFragment
      || sdp.split(/\r?\n/).includes(`a=ice-ufrag:${candidate.usernameFragment}`));
  }

  async function flushCandidates() {
    const ready = candidates.filter(matchesRemote);
    candidates = candidates.filter((candidate) => !matchesRemote(candidate));
    for (const candidate of ready) {
      try { await peer.addIceCandidate(candidate); } catch {}
    }
  }

  const stateEvents = ['connectionstatechange', 'iceconnectionstatechange'];
  stateEvents.forEach((event) => peer.addEventListener?.(event, observe));
  return {
    offer: () => enqueue(() => sendOffer()),
    receiveOffer: (description, afterAnswer) => enqueue(async () => {
      if (description?.type !== 'offer') return;
      if (peer.signalingState !== 'stable') {
        if (!polite) return;
        pendingOffer = true;
      }
      await prepare({ offer: false, restart: established });
      if (closed) return;
      await peer.setRemoteDescription({ type: description.type, sdp: description.sdp });
      await flushCandidates();
      if (closed) return;
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (closed) return;
      emit('webrtc-resposta', 'resposta', { type: answer.type, sdp: answer.sdp, idOferta: description.idOferta });
      observe();
      if (pendingOffer || afterAnswer) await sendOffer();
    }),
    receiveAnswer: (description, adjust) => enqueue(async () => {
      if (description?.type !== 'answer' || peer.signalingState !== 'have-local-offer'
        || (description.idOferta != null && description.idOferta !== localOfferId)) return;
      await peer.setRemoteDescription(adjust({ type: description.type, sdp: description.sdp }));
      await flushCandidates();
      if (pendingOffer) await sendOffer();
    }),
    receiveCandidate: (candidate) => enqueue(async () => {
      if (!candidate) return;
      candidates.push(candidate);
      if (candidates.length > 128) candidates.shift();
      await flushCandidates();
    }),
    close() {
      closed = true;
      cancelTimer();
      candidates = [];
      stateEvents.forEach((event) => peer.removeEventListener?.(event, observe));
    },
  };
}
