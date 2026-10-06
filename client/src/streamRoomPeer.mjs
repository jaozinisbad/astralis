import { getVideoEncodingParameters } from './streamQuality.mjs';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createStreamRoomPeerSession({
  socket,
  roomId,
  role,
  streamId,
  quality = {},
  onRemoteStream = () => {},
  onQualityError = () => {},
  onPeerConnectionFailed = () => {},
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  reconnectDelayMs = 1_500,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const peers = new Map();
  const connecting = new Map();
  const candidatesWaitingForDescription = new Map();
  const reconnectTimers = new Map();
  const viewers = new Set();
  let localStream = null;
  let currentQuality = quality;
  let closed = false;

  if (!socket || !roomId || (role !== 'host' && role !== 'viewer')) {
    throw new TypeError('Socket, sala e papel válido são necessários para transmitir.');
  }
  if (!RTCPeerConnectionImpl) throw new Error('Este navegador não oferece suporte a WebRTC.');

  function emitSignal(type, peerId, payload) {
    if (closed || !peerId) return;
    const field = type === 'offer' ? 'descricao' : type === 'answer' ? 'resposta' : 'candidato';
    socket.emit(`sala:sinal:${type === 'offer' ? 'oferta' : type === 'answer' ? 'resposta' : 'candidato'}`, {
      roomId,
      para: peerId,
      ...(streamId ? { streamId } : {}),
      [field]: payload,
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
  }

  function schedulePeerRecovery(peerId, peer) {
    if (closed || reconnectTimers.has(peerId)) return;
    const timer = setTimeoutImpl(() => {
      reconnectTimers.delete(peerId);
      if (closed || peers.get(peerId) !== peer
        || !['disconnected', 'failed'].includes(peer.connectionState)) return;

      if (role === 'host') {
        closePeer(peerId, true);
        if (localStream && viewers.has(peerId)) connectViewer(peerId).catch(() => closePeer(peerId, true));
        return;
      }

      closePeer(peerId);
      onPeerConnectionFailed(peerId);
    }, reconnectDelayMs);
    reconnectTimers.set(peerId, timer);
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
      } else if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        schedulePeerRecovery(peerId, peer);
      } else if (peer.connectionState === 'closed') {
        clearReconnectTimer(peerId);
        if (peers.get(peerId) === peer) closePeer(peerId, role === 'host');
      }
    };
    return peer;
  }

  async function applyWaitingCandidates(peerId, peer) {
    const waiting = candidatesWaitingForDescription.get(peerId) || [];
    candidatesWaitingForDescription.delete(peerId);
    for (const candidate of waiting) await peer.addIceCandidate(candidate);
  }

  async function updateVideoBitrates() {
    const video = getVideoEncodingParameters(currentQuality, viewers.size);
    await Promise.all([...peers.values()].map(async (peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
      if (!sender) return;
      const parameters = sender.getParameters();
      parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((encoding) => ({
        ...encoding,
        maxBitrate: video.maxBitrate,
      }));
      parameters.degradationPreference = video.degradationPreference;
      try {
        await sender.setParameters(parameters);
      } catch (error) {
        onQualityError(error);
      }
    }));
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
      await updateVideoBitrates();
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      emitSignal('offer', peerId, peer.localDescription || offer);
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

  function closePeer(peerId, preserveViewer = false) {
    clearReconnectTimer(peerId);
    if (!preserveViewer) viewers.delete(peerId);
    const peer = peers.get(peerId);
    if (!peer) {
      if (role === 'host') updateVideoBitrates().catch(() => {});
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
    ['sala:sinal:oferta', receiveOffer],
    ['sala:sinal:resposta', receiveAnswer],
    ['sala:sinal:candidato', receiveCandidate],
    ['sala:espectador-entrou', onViewerJoined],
    ['sala:espectador-saiu', onViewerLeft],
  ];
  listeners.forEach(([event, listener]) => socket.on(event, listener));

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
      if (role === 'host') updateVideoBitrates().catch(() => {});
    },
    closePeer,
    close() {
      if (closed) return;
      closed = true;
      listeners.forEach(([event, listener]) => socket.off(event, listener));
      [...peers.keys()].forEach(closePeer);
      viewers.clear();
      connecting.clear();
      candidatesWaitingForDescription.clear();
      reconnectTimers.forEach((timer) => clearTimeoutImpl(timer));
      reconnectTimers.clear();
      localStream = null;
    },
    getPeerCount: () => peers.size,
  };
}
