const { randomUUID } = require('node:crypto');

const DIRECT_CHANNEL_PREFIX = 'direta:';
const isDirectChannel = (channelId) => typeof channelId === 'string' && channelId.startsWith(DIRECT_CHANNEL_PREFIX);
const failure = (code, error) => ({ ok: false, code, error });

// A chamada pertence a dois usuários, mas o áudio pertence apenas aos dois
// sockets escolhidos ao ligar/atender. Outras abas nunca entram por conhecer o ID.
function createDirectCallManager({
  io,
  areFriends,
  getUser,
  isExternallyBusy = () => false,
  makeId = randomUUID,
  ringTimeoutMs = 30_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const calls = new Map();
  const callsByUser = new Map();
  const disconnectedSockets = new WeakSet();

  function connected(socket) {
    return Boolean(socket?.usuario?.id && !socket.espectadorAnonimo && socket.connected !== false
      && !disconnectedSockets.has(socket) && io.sockets.sockets.get(socket.id) === socket);
  }

  function userSockets(userId) {
    return [...io.sockets.sockets.values()].filter((socket) => (
      connected(socket) && Number(socket.usuario.id) === userId
    ));
  }

  function profile(user) {
    return {
      id: Number(user.id),
      nome: user.nome,
      avatar_cor: user.avatar_cor || '#9270f4',
      avatar_url: user.avatar_url || null,
    };
  }

  function summary(call) {
    return {
      id: call.id,
      canalId: `${DIRECT_CHANNEL_PREFIX}${call.id}`,
      status: call.status,
      caller: call.caller,
      callee: call.callee,
    };
  }

  function emit(socketId, event, data) {
    io.to(socketId).emit(event, data);
  }

  function busy(userId) {
    return callsByUser.has(userId) || isExternallyBusy(userId);
  }

  function activeSocket(call, socket) {
    return connected(socket) && call.status === 'active'
      && (call.callerSocketId === socket.id || call.calleeSocketId === socket.id);
  }

  function finish(call, reason) {
    if (calls.get(call.id) !== call) return;
    calls.delete(call.id);
    callsByUser.delete(call.caller.id);
    callsByUser.delete(call.callee.id);
    clearTimeoutImpl(call.timer);

    const notified = new Set([call.callerSocketId, ...call.ringingSocketIds]);
    if (call.calleeSocketId) notified.add(call.calleeSocketId);
    for (const socketId of call.joined.keys()) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket?.canalVozAtual === `${DIRECT_CHANNEL_PREFIX}${call.id}`) {
        socket.canalVozAtual = null;
      }
      for (const peerId of call.joined.keys()) {
        if (socketId !== peerId) emit(peerId, 'peer-saiu', { socketId });
      }
    }
    call.joined.clear();
    for (const socketId of notified) emit(socketId, 'chamada:encerrada', { callId: call.id, reason });
  }

  async function start(socket, data) {
    const userId = Number(socket.usuario?.id);
    const targetId = Number(data?.paraUsuarioId);
    if (!connected(socket)) return failure('forbidden', 'Entre na conta para ligar.');
    if (!Number.isSafeInteger(targetId) || targetId < 1 || userId === targetId) {
      return failure('invalid', 'Escolha um amigo para ligar.');
    }
    if (busy(userId)) return failure('busy', 'Encerre sua chamada atual antes de ligar.');
    if (!(await areFriends(userId, targetId))) return failure('not-friends', 'Adicione esta pessoa aos amigos antes de ligar.');
    const [caller, callee] = await Promise.all([getUser(userId), getUser(targetId)]);
    if (!caller || !callee) return failure('not-found', 'Esta conta não está disponível.');
    // As consultas podem terminar depois de uma desconexão ou de outra ligação.
    if (!connected(socket)) return failure('disconnected', 'Você se desconectou. Tente ligar novamente.');
    if (busy(userId) || busy(targetId)) return failure('busy', 'Um de vocês já está em uma chamada.');
    const recipients = userSockets(targetId);
    if (!recipients.length) return failure('offline', 'Seu amigo está offline.');

    const call = {
      id: makeId(),
      status: 'ringing',
      caller: profile(caller),
      callee: profile(callee),
      callerSocketId: socket.id,
      calleeSocketId: null,
      ringingSocketIds: new Set(recipients.map((item) => item.id)),
      joined: new Map(),
    };
    calls.set(call.id, call);
    callsByUser.set(userId, call.id);
    callsByUser.set(targetId, call.id);
    call.timer = setTimeoutImpl(() => finish(call, 'timeout'), ringTimeoutMs);
    call.timer?.unref?.();
    const result = { ok: true, call: summary(call) };
    emit(socket.id, 'chamada:estado', { call: result.call });
    for (const recipient of recipients) emit(recipient.id, 'chamada:recebida', { call: result.call });
    return result;
  }

  async function accept(socket, data) {
    const call = calls.get(data?.callId);
    if (!call) return failure('not-found', 'Esta chamada já terminou.');
    if (!connected(socket) || Number(socket.usuario.id) !== call.callee.id
      || !call.ringingSocketIds.has(socket.id)) {
      return failure('forbidden', 'Esta chamada não foi enviada para você.');
    }
    if (call.status !== 'ringing') return failure('busy', 'Esta chamada já foi atendida.');
    if (!(await areFriends(call.caller.id, call.callee.id))) {
      finish(call, 'friendship-removed');
      return failure('not-friends', 'A amizade foi removida.');
    }
    if (calls.get(call.id) !== call) return failure('not-found', 'Esta chamada já terminou.');
    if (call.status !== 'ringing') return failure('busy', 'Esta chamada já foi atendida.');
    if (!connected(socket) || !connected(io.sockets.sockets.get(call.callerSocketId))) {
      return failure('disconnected', 'Um de vocês se desconectou.');
    }
    if (isExternallyBusy(call.caller.id) || isExternallyBusy(call.callee.id)) {
      finish(call, 'busy');
      return failure('busy', 'Um de vocês já está em outra chamada.');
    }
    clearTimeoutImpl(call.timer);
    call.status = 'active';
    call.calleeSocketId = socket.id;
    const result = { ok: true, call: summary(call) };
    emit(call.callerSocketId, 'chamada:estado', { call: result.call });
    emit(call.calleeSocketId, 'chamada:estado', { call: result.call });
    for (const socketId of call.ringingSocketIds) {
      if (socketId !== socket.id) emit(socketId, 'chamada:encerrada', { callId: call.id, reason: 'answered-elsewhere' });
    }
    call.ringingSocketIds = new Set([socket.id]);
    return result;
  }

  function end(socket, data, action) {
    const call = calls.get(data?.callId);
    if (!call) return failure('not-found', 'Esta chamada já terminou.');
    if (!connected(socket)) return failure('forbidden', 'Esta chamada não pertence a esta sessão.');
    const canCancel = call.status === 'ringing' && socket.id === call.callerSocketId;
    const canDecline = call.status === 'ringing' && Number(socket.usuario.id) === call.callee.id
      && call.ringingSocketIds.has(socket.id);
    const canEnd = activeSocket(call, socket);
    // A cancel/decline can cross the acceptance packet in flight. It still
    // means hang up, but only for the selected endpoint of the correct user.
    if (!(action === 'cancelled' && (canCancel || canEnd && socket.id === call.callerSocketId)
      || action === 'declined' && (canDecline || canEnd && socket.id === call.calleeSocketId)
      || action === 'ended' && canEnd)) {
      return failure('forbidden', 'Esta chamada não pertence a esta sessão.');
    }
    finish(call, call.status === 'active' ? 'ended' : action);
    return { ok: true };
  }

  function joinVoice(socket, channelId) {
    const call = calls.get(channelId.slice(DIRECT_CHANNEL_PREFIX.length));
    if (!call || !activeSocket(call, socket)) return failure('forbidden', 'Esta chamada não está disponível.');
    if (socket.canalVozAtual && socket.canalVozAtual !== channelId) return failure('busy', 'Encerre sua chamada atual.');
    const peers = [...call.joined.values()].filter((peer) => peer.socketId !== socket.id);
    const user = socket.id === call.callerSocketId ? call.caller : call.callee;
    const participant = {
      socketId: socket.id, usuarioId: user.id, nome: user.nome,
      avatarCor: user.avatar_cor, avatarUrl: user.avatar_url,
    };
    const alreadyJoined = call.joined.has(socket.id);
    call.joined.set(socket.id, participant);
    socket.canalVozAtual = channelId;
    socket.emit('peers-existentes', { peers });
    if (!alreadyJoined) for (const peer of peers) emit(peer.socketId, 'novo-peer', participant);
    return { ok: true };
  }

  function leaveVoice(socket) {
    if (!isDirectChannel(socket.canalVozAtual)) return false;
    const call = calls.get(socket.canalVozAtual.slice(DIRECT_CHANNEL_PREFIX.length));
    if (call && activeSocket(call, socket)) finish(call, 'ended');
    socket.canalVozAtual = null;
    return true;
  }

  function canSignal(socket, targetId) {
    if (!connected(socket) || !isDirectChannel(socket.canalVozAtual) || typeof targetId !== 'string') return false;
    const call = calls.get(socket.canalVozAtual.slice(DIRECT_CHANNEL_PREFIX.length));
    const target = io.sockets.sockets.get(targetId);
    return Boolean(call && targetId !== socket.id && activeSocket(call, socket)
      && activeSocket(call, target) && target.canalVozAtual === socket.canalVozAtual
      && call.joined.has(socket.id) && call.joined.has(targetId));
  }

  function screenStopped(socket) {
    if (!isDirectChannel(socket.canalVozAtual)) return false;
    const call = calls.get(socket.canalVozAtual.slice(DIRECT_CHANNEL_PREFIX.length));
    for (const peerId of call?.joined.keys() || []) {
      if (canSignal(socket, peerId)) emit(peerId, 'tela-parada', { socketId: socket.id });
    }
    return true;
  }

  function disconnect(socket) {
    disconnectedSockets.add(socket);
    const call = calls.get(callsByUser.get(Number(socket.usuario?.id)));
    if (!call) return;
    if (socket.id === call.callerSocketId || socket.id === call.calleeSocketId) {
      finish(call, 'disconnected');
    } else if (call.status === 'ringing' && call.callee.id === Number(socket.usuario?.id)) {
      call.ringingSocketIds.delete(socket.id);
      if (!userSockets(call.callee.id).some((item) => call.ringingSocketIds.has(item.id))) finish(call, 'disconnected');
    }
  }

  async function revalidateUsers(userIds) {
    const callIds = new Set(userIds.map((id) => callsByUser.get(Number(id))).filter(Boolean));
    for (const callId of callIds) {
      const call = calls.get(callId);
      if (call && !(await areFriends(call.caller.id, call.callee.id))) finish(call, 'friendship-removed');
    }
  }

  function register(socket) {
    const handler = (operation) => async (data, callback) => {
      let result;
      try { result = await operation(socket, data); }
      catch (error) {
        console.error('Erro em chamada direta:', error);
        result = failure('unavailable', 'Não foi possível completar a chamada. Tente novamente.');
      }
      if (typeof callback === 'function') callback(result);
    };
    socket.on('chamada:iniciar', handler(start));
    socket.on('chamada:aceitar', handler(accept));
    socket.on('chamada:recusar', handler((owner, data) => end(owner, data, 'declined')));
    socket.on('chamada:cancelar', handler((owner, data) => end(owner, data, 'cancelled')));
    socket.on('chamada:encerrar', handler((owner, data) => end(owner, data, 'ended')));
    // Uma nova aba pode receber um convite ainda pendente, mas nunca herda áudio.
    const call = calls.get(callsByUser.get(Number(socket.usuario?.id)));
    if (call?.status === 'ringing' && call.callee.id === Number(socket.usuario.id)) {
      call.ringingSocketIds.add(socket.id);
      socket.emit('chamada:recebida', { call: summary(call) });
    }
  }

  return { register, start, accept, end, joinVoice, leaveVoice, canSignal, screenStopped, disconnect, revalidateUsers, isUserBusy: busy };
}

module.exports = { createDirectCallManager, isDirectChannel };
