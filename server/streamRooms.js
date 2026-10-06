const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const CODIGOS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function gerarCodigo() {
  return Array.from(randomBytes(8), (byte) => CODIGOS[byte % CODIGOS.length]).join('');
}

function compararCodigo(informado, esperado) {
  if (typeof informado !== 'string') return false;
  const normalizado = informado.trim().toUpperCase();
  if (normalizado.length !== esperado.length) return false;
  return timingSafeEqual(Buffer.from(normalizado), Buffer.from(esperado));
}

function criarResumoSala(sala) {
  return {
    id: sala.id,
    name: sala.name,
    ownerName: sala.ownerName,
    visibility: sala.visibility,
    isLive: sala.isLive,
    presenterSocketId: sala.presenterSocketId,
    presenterName: sala.presenterName,
    presenters: sala.presenters.map((presenter) => ({ ...presenter })),
    reservedPresenterSlot: Boolean(sala.disconnectedPresenterSocketId),
    viewerCount: sala.viewers.size,
    createdAt: sala.createdAt,
  };
}

function copiarEstadoYoutube(sala) {
  return {
    source: sala.youtubeSource ? { ...sala.youtubeSource } : null,
    playback: { ...sala.youtubePlayback },
  };
}

function createStreamRoomManager({
  makeId = randomUUID,
  makeCode = gerarCodigo,
  hostReconnectGraceMs = 30_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const salas = new Map();
  const salasPorSocket = new Map();

  function gerarCodigoPrivadoUnico() {
    for (let tentativa = 0; tentativa < 8; tentativa += 1) {
      const codigo = makeCode();
      if (typeof codigo !== 'string' || !codigo.trim()) continue;
      const jaExiste = Array.from(salas.values()).some((sala) => (
        sala.accessCode && compararCodigo(codigo, sala.accessCode)
      ));
      if (!jaExiste) return codigo;
    }
    return null;
  }

  function resolvePrivateRoomId(accessCode) {
    const sala = Array.from(salas.values()).find((item) => (
      item.visibility === 'private'
      && item.accessCode
      && compararCodigo(accessCode, item.accessCode)
    ));
    return sala?.id ?? null;
  }

  function socketsDaSala(sala, excluirSocketId = null) {
    return [sala.ownerSocketId, ...sala.viewers.keys()]
      .filter((socketId) => socketId !== excluirSocketId);
  }

  function nomeDoMembro(sala, socketId) {
    if (socketId === sala.ownerSocketId) return sala.ownerName;
    return sala.viewers.get(socketId)?.userName || 'Visitante';
  }

  function atualizarPresenters(sala) {
    sala.presenterSocketId = sala.presenters[0]?.socketId ?? null;
    sala.presenterName = sala.presenters[0]?.name ?? null;
    sala.isLive = sala.presenters.length > 0;
  }

  function copiarPresenters(sala) {
    return sala.presenters.map((presenter) => ({ ...presenter }));
  }

  function resultadoDeEntrada(sala, socketId, role) {
    const youtubeState = copiarEstadoYoutube(sala);
    const peerSocketIds = sala.presenters.length
      ? (sala.presenters.some((presenter) => presenter.socketId === socketId)
        ? socketsDaSala(sala, socketId)
        : sala.presenters.map((presenter) => presenter.socketId))
      : role === 'host'
        ? Array.from(sala.viewers.keys())
        : [sala.ownerSocketId];
    return {
      ok: true,
      room: criarResumoSala(sala),
      role,
      hostSocketId: sala.ownerSocketId,
      peerSocketIds,
      presenterSocketId: sala.presenterSocketId,
      presenterName: sala.presenterName,
      presenters: copiarPresenters(sala),
      youtubeSource: youtubeState.source,
      youtubePlayback: youtubeState.playback,
      ...(role === 'host' && sala.accessCode ? { accessCode: sala.accessCode } : {}),
    };
  }

  function createRoom({ ownerSocketId, ownerId, ownerName, name, visibility }) {
    const nome = typeof name === 'string' ? name.trim() : '';
    if (!ownerSocketId || ownerId == null) return { ok: false, error: 'É necessário entrar na conta para criar uma sala.' };
    if (salasPorSocket.has(ownerSocketId)) return { ok: false, error: 'Você já está em uma sala.' };
    if (!nome || nome.length > 60) return { ok: false, error: 'O nome deve ter entre 1 e 60 caracteres.' };
    if (visibility !== 'public' && visibility !== 'private') return { ok: false, error: 'Escolha se a sala será pública ou privada.' };

    const accessCode = visibility === 'private' ? gerarCodigoPrivadoUnico() : null;
    if (visibility === 'private' && !accessCode) {
      return { ok: false, error: 'Não foi possível gerar um código único para a sala. Tente novamente.' };
    }

    const id = makeId();
    if (!id || salas.has(id)) return { ok: false, error: 'Não foi possível criar um identificador de sala.' };
    const createdAt = new Date().toISOString();
    const sala = {
      id,
      name: nome,
      ownerId,
      ownerName: typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim().slice(0, 32) : 'Anfitrião',
      ownerSocketId,
      visibility,
      accessCode,
      isLive: false,
      presenters: [],
      presenterSocketId: null,
      presenterName: null,
      disconnectedPresenterSocketId: null,
      disconnectedPresenterIndex: null,
      ownerDisconnected: false,
      hostDisconnectTimer: null,
      youtubeSource: null,
      youtubePlayback: {
        action: 'pause',
        currentTime: 0,
        updatedAt: createdAt,
        revision: 0,
      },
      viewers: new Map(),
      createdAt,
    };
    salas.set(id, sala);
    salasPorSocket.set(ownerSocketId, { roomId: id, role: 'host' });
    const youtubeState = copiarEstadoYoutube(sala);
    return {
      ok: true,
      room: criarResumoSala(sala),
      role: 'host',
      peerSocketIds: [],
      presenterSocketId: null,
      presenterName: null,
      presenters: [],
      youtubeSource: youtubeState.source,
      youtubePlayback: youtubeState.playback,
      ...(sala.accessCode ? { accessCode: sala.accessCode } : {}),
    };
  }

  function joinRoom({ roomId: requestedRoomId, socketId, userId = null, userName, accessCode }) {
    const roomId = requestedRoomId || resolvePrivateRoomId(accessCode);
    const sala = salas.get(roomId);
    if (!sala) {
      return {
        ok: false,
        error: requestedRoomId ? 'Esta sala não está mais ativa.' : 'Código inválido ou sala encerrada.',
      };
    }
    if (!socketId) return { ok: false, error: 'Conexão inválida.' };

    const membership = salasPorSocket.get(socketId);
    if (membership) {
      if (membership.roomId !== roomId) return { ok: false, error: 'Saia da outra sala antes de entrar nesta.' };
      return resultadoDeEntrada(sala, socketId, membership.role);
    }
    const hostReconnected = sala.ownerDisconnected && userId != null && userId === sala.ownerId;
    if (sala.accessCode && !hostReconnected && !compararCodigo(accessCode, sala.accessCode)) {
      return { ok: false, error: 'Código de acesso inválido.' };
    }

    if (hostReconnected) {
      const previousOwnerSocketId = sala.ownerSocketId;
      if (sala.hostDisconnectTimer) clearTimeoutImpl(sala.hostDisconnectTimer);
      sala.hostDisconnectTimer = null;
      sala.ownerDisconnected = false;
      sala.ownerSocketId = socketId;
      salasPorSocket.delete(previousOwnerSocketId);
      if (sala.disconnectedPresenterSocketId === previousOwnerSocketId) {
        sala.presenters.splice(sala.disconnectedPresenterIndex ?? 0, 0, {
          socketId,
          name: sala.ownerName,
        });
        atualizarPresenters(sala);
      }
      sala.disconnectedPresenterSocketId = null;
      sala.disconnectedPresenterIndex = null;
    }

    const role = socketId === sala.ownerSocketId ? 'host' : 'viewer';
    if (role === 'viewer') {
      const nome = typeof userName === 'string' && userName.trim()
        ? userName.trim().slice(0, 32)
        : 'Visitante';
      sala.viewers.set(socketId, { userId, userName: nome });
    }
    salasPorSocket.set(socketId, { roomId, role });
    return { ...resultadoDeEntrada(sala, socketId, role), hostReconnected };
  }

  function setLive(roomId, socketId, isLive) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    const membership = salasPorSocket.get(socketId);
    if (!membership || membership.roomId !== roomId) {
      return { ok: false, error: 'Entre na sala antes de controlar a transmissão.' };
    }
    if (typeof isLive !== 'boolean') {
      return { ok: false, error: 'O estado da transmissão é inválido.' };
    }
    if (isLive && sala.youtubeSource) {
      return { ok: false, error: 'Remova a fonte do YouTube antes de iniciar uma transmissão de tela.' };
    }

    let previousPresenterSocketId = null;
    let previousPresenterName = null;
    if (isLive) {
      if (!sala.presenters.some((presenter) => presenter.socketId === socketId)
        && sala.presenters.length + Number(Boolean(sala.disconnectedPresenterSocketId)) >= 2) {
        return {
          ok: false,
          error: 'Já existem duas transmissões nesta sala ou uma vaga reservada ao anfitrião.',
          presenterSocketId: sala.presenterSocketId,
          presenterName: sala.presenterName,
          presenters: copiarPresenters(sala),
        };
      }
      if (!sala.presenters.some((presenter) => presenter.socketId === socketId)) {
        sala.presenters.push({ socketId, name: nomeDoMembro(sala, socketId) });
      }
      atualizarPresenters(sala);
    } else {
      const index = sala.presenters.findIndex((presenter) => presenter.socketId === socketId);
      if (index < 0 && sala.presenters.length) {
        return {
          ok: false,
          error: 'Somente quem está transmitindo pode parar a transmissão.',
          presenterSocketId: sala.presenterSocketId,
          presenterName: sala.presenterName,
          presenters: copiarPresenters(sala),
        };
      }
      if (index >= 0) {
        const [previous] = sala.presenters.splice(index, 1);
        previousPresenterSocketId = previous.socketId;
        previousPresenterName = previous.name;
        atualizarPresenters(sala);
      }
    }

    return {
      ok: true,
      room: criarResumoSala(sala),
      peerSocketIds: socketsDaSala(sala, socketId),
      presenterSocketId: sala.presenterSocketId,
      presenterName: sala.presenterName,
      presenters: copiarPresenters(sala),
      previousPresenterSocketId,
      previousPresenterName,
    };
  }

  function setYoutubeSource(roomId, socketId, videoId) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    if (sala.ownerSocketId !== socketId || salasPorSocket.get(socketId)?.roomId !== roomId
      || salasPorSocket.get(socketId)?.role !== 'host') {
      return { ok: false, error: 'Somente o anfitrião pode alterar a fonte do YouTube.' };
    }
    if (videoId !== null && sala.isLive) {
      return { ok: false, error: 'Pare a transmissão de tela antes de adicionar uma fonte do YouTube.' };
    }
    if (videoId !== null && (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId))) {
      return { ok: false, error: 'O identificador do vídeo do YouTube é inválido.' };
    }

    sala.youtubeSource = videoId === null ? null : { videoId };
    sala.youtubePlayback = {
      action: videoId === null ? 'pause' : 'play',
      currentTime: 0,
      updatedAt: new Date().toISOString(),
      revision: sala.youtubePlayback.revision + 1,
    };
    const state = copiarEstadoYoutube(sala);
    return { ok: true, ...state };
  }

  function setYoutubePlayback(roomId, socketId, { action, currentTime } = {}) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    const membership = salasPorSocket.get(socketId);
    if (!membership || membership.roomId !== roomId) {
      return { ok: false, error: 'Entre na sala antes de controlar o vídeo.' };
    }
    if (!sala.youtubeSource) return { ok: false, error: 'Não há uma fonte do YouTube nesta sala.' };
    if (!['play', 'pause', 'seek'].includes(action)) {
      return { ok: false, error: 'Ação de reprodução inválida.' };
    }
    if (action === 'seek' && currentTime === undefined) {
      return { ok: false, error: 'Informe a posição do vídeo.' };
    }
    const position = currentTime === undefined ? sala.youtubePlayback.currentTime : currentTime;
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 86400) {
      return { ok: false, error: 'A posição do vídeo deve estar entre 0 e 86400 segundos.' };
    }

    sala.youtubePlayback = {
      // `action` in persisted state represents the play/pause mode. A seek is
      // a position update, so late joiners still know whether to start playing.
      action: action === 'seek'
        ? sala.youtubePlayback.action === 'pause' ? 'pause' : 'play'
        : action,
      currentTime: position,
      updatedAt: new Date().toISOString(),
      revision: sala.youtubePlayback.revision + 1,
    };
    const state = copiarEstadoYoutube(sala);
    return { ok: true, ...state };
  }

  function endRoom(roomId, socketId) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    if (sala.ownerSocketId !== socketId || salasPorSocket.get(socketId)?.role !== 'host') {
      return { ok: false, error: 'Somente o anfitrião pode encerrar a sala.' };
    }
    const viewerSocketIds = Array.from(sala.viewers.keys());
    const presenterSocketId = sala.presenterSocketId;
    const presenterName = sala.presenterName;
    const presenters = copiarPresenters(sala);
    if (sala.hostDisconnectTimer) clearTimeoutImpl(sala.hostDisconnectTimer);
    sala.hostDisconnectTimer = null;
    salasPorSocket.delete(sala.ownerSocketId);
    viewerSocketIds.forEach((viewerSocketId) => salasPorSocket.delete(viewerSocketId));
    salas.delete(roomId);
    return {
      ok: true,
      closed: true,
      roomId,
      hostSocketId: sala.ownerSocketId,
      viewerSocketIds,
      presenterSocketId,
      presenterName,
      presenters,
    };
  }

  function leaveRoom(socketId) {
    const membership = salasPorSocket.get(socketId);
    if (!membership) return { ok: false, error: 'Você não está em uma sala.' };
    if (membership.role === 'host') return endRoom(membership.roomId, socketId);

    const sala = salas.get(membership.roomId);
    const presenterIndex = sala?.presenters.findIndex((presenter) => presenter.socketId === socketId) ?? -1;
    const presenterSaiu = presenterIndex >= 0;
    const previousPresenterName = presenterSaiu ? sala.presenters[presenterIndex].name : null;
    if (presenterSaiu && sala) {
      sala.presenters.splice(presenterIndex, 1);
      atualizarPresenters(sala);
    }
    salasPorSocket.delete(socketId);
    sala?.viewers.delete(socketId);
    return {
      ok: true,
      closed: false,
      roomId: membership.roomId,
      hostSocketId: sala?.ownerSocketId,
      presenterSocketId: sala?.presenterSocketId ?? null,
      presenterName: sala?.presenterName ?? null,
      presenters: sala ? copiarPresenters(sala) : [],
      transmissionStopped: presenterSaiu,
      previousPresenterSocketId: presenterSaiu ? socketId : null,
      previousPresenterName,
      room: sala ? criarResumoSala(sala) : null,
    };
  }

  function disconnectHost(socketId, onExpired = () => {}) {
    const membership = salasPorSocket.get(socketId);
    if (!membership || membership.role !== 'host') return null;
    const sala = salas.get(membership.roomId);
    if (!sala || sala.ownerSocketId !== socketId) return null;

    const presenterIndex = sala.presenters.findIndex((presenter) => presenter.socketId === socketId);
    const presenterDisconnected = presenterIndex >= 0;
    const previousPresenterName = presenterDisconnected ? sala.presenters[presenterIndex].name : null;
    if (presenterDisconnected) {
      sala.disconnectedPresenterSocketId = socketId;
      sala.disconnectedPresenterIndex = presenterIndex;
      sala.presenters.splice(presenterIndex, 1);
      atualizarPresenters(sala);
    }
    sala.ownerDisconnected = true;
    if (sala.hostDisconnectTimer) clearTimeoutImpl(sala.hostDisconnectTimer);
    sala.hostDisconnectTimer = setTimeoutImpl(() => {
      sala.hostDisconnectTimer = null;
      if (!sala.ownerDisconnected || sala.ownerSocketId !== socketId) return;
      const result = endRoom(sala.id, socketId);
      if (result.ok) onExpired(result);
    }, hostReconnectGraceMs);
    sala.hostDisconnectTimer?.unref?.();

    return {
      ok: true,
      pendingHostReconnect: true,
      roomId: sala.id,
      room: criarResumoSala(sala),
      presenterSocketId: sala.presenterSocketId,
      presenterName: sala.presenterName,
      presenters: copiarPresenters(sala),
      transmissionStopped: presenterDisconnected,
      previousPresenterSocketId: presenterDisconnected ? socketId : null,
      previousPresenterName,
    };
  }

  function getRoom(roomId) {
    const sala = salas.get(roomId);
    return sala ? criarResumoSala(sala) : null;
  }

  function getSocketRole(socketId, roomId) {
    const membership = salasPorSocket.get(socketId);
    return membership && membership.roomId === roomId ? membership.role : null;
  }

  function getPresenterSocketId(roomId) {
    return salas.get(roomId)?.presenterSocketId ?? null;
  }

  function getPresenters(roomId) {
    const sala = salas.get(roomId);
    return sala ? copiarPresenters(sala) : [];
  }

  function resolveStreamId(roomId, streamId, { fromSocketId, toSocketId, signalType } = {}) {
    const sala = salas.get(roomId);
    if (!sala) return null;
    if (streamId === undefined) {
      if (sala.presenters.length === 1) return sala.presenters[0].socketId;
      const isPresenter = (socketId) => sala.presenters.some((presenter) => presenter.socketId === socketId);
      // Older clients do not tag signals. The direction identifies their
      // broadcast, and the relay still tags it for updated clients.
      if (signalType === 'offer') return isPresenter(fromSocketId) ? fromSocketId : null;
      if (signalType === 'answer') return isPresenter(toSocketId) ? toSocketId : null;
      if (signalType === 'candidate') {
        if (isPresenter(fromSocketId)) return fromSocketId;
        return isPresenter(toSocketId) ? toSocketId : null;
      }
      return null;
    }
    return typeof streamId === 'string' && sala.presenters.some((presenter) => presenter.socketId === streamId)
      ? streamId : null;
  }

  function canSignal({ roomId, fromSocketId, toSocketId, signalType, streamId }) {
    const sala = salas.get(roomId);
    if (!sala || !sala.isLive || fromSocketId === toSocketId) return false;
    const fromRole = getSocketRole(fromSocketId, roomId);
    const toRole = getSocketRole(toSocketId, roomId);
    const resolvedStreamId = resolveStreamId(roomId, streamId, { fromSocketId, toSocketId, signalType });
    if (!fromRole || !toRole || !resolvedStreamId) return false;

    if (signalType === 'offer') return fromSocketId === resolvedStreamId;
    if (signalType === 'answer') return toSocketId === resolvedStreamId;
    if (signalType === 'candidate') {
      return fromSocketId === resolvedStreamId || toSocketId === resolvedStreamId;
    }
    return false;
  }

  return {
    createRoom,
    joinRoom,
    resolvePrivateRoomId,
    setLive,
    endRoom,
    leaveRoom,
    disconnectHost,
    getRoom,
    getSocketRole,
    getPresenterSocketId,
    getPresenters,
    resolveStreamId,
    setYoutubeSource,
    setYoutubePlayback,
    canSignal,
    listPublicRooms: () => Array.from(salas.values())
      .filter((sala) => sala.visibility === 'public' && sala.isLive)
      .map(criarResumoSala),
  };
}

function registrarEventosSala({ socket, io, manager }) {
  const reply = (callback, result) => {
    if (typeof callback === 'function') callback(result);
  };
  const objetoOuVazio = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const nomeSalaSocket = (roomId) => `sala-${roomId}`;
  const socketsConectados = () => io.sockets?.sockets;
  let entradaPendente = null;
  const publicarSalas = () => io.emit('salas:atualizadas', { rooms: manager.listPublicRooms() });

  function removerSocketDaSala(socketAlvo, nomeSala) {
    if (!socketAlvo || typeof socketAlvo.leave !== 'function') return;
    try {
      const resultado = socketAlvo.leave(nomeSala);
      if (resultado && typeof resultado.catch === 'function') {
        resultado.catch(() => removerSocketPeloAdapter(socketAlvo.id, nomeSala));
      }
    } catch {
      removerSocketPeloAdapter(socketAlvo.id, nomeSala);
    }
  }

  function removerSocketPeloAdapter(socketId, nomeSala) {
    if (!socketId || typeof io.in !== 'function') return;
    try {
      const resultado = io.in(socketId).socketsLeave(nomeSala);
      if (resultado && typeof resultado.catch === 'function') resultado.catch(() => {});
    } catch {
      // A limpeza local continua mesmo se o adapter também rejeitar o fallback.
    }
  }

  function removerSalaPeloAdapter(nomeSala) {
    if (typeof io.in !== 'function') return;
    try {
      const resultado = io.in(nomeSala).socketsLeave(nomeSala);
      if (resultado && typeof resultado.catch === 'function') resultado.catch(() => {});
    } catch {
      // As tentativas individuais já foram feitas antes do fallback por sala.
    }
  }

  function removerMembrosDaSala(nomeSala, socketIds = [], removerTodos = false) {
    const alvos = new Set([socket]);
    const sockets = socketsConectados();
    socketIds.forEach((socketId) => {
      const socketAlvo = socketId === socket.id ? socket : sockets?.get(socketId);
      if (socketAlvo) alvos.add(socketAlvo);
    });
    alvos.forEach((socketAlvo) => removerSocketDaSala(socketAlvo, nomeSala));
    if (removerTodos) removerSalaPeloAdapter(nomeSala);
  }

  function pertenceASala(socketId, roomId) {
    const socketAlvo = socketsConectados()?.get(socketId);
    const rooms = socketAlvo?.rooms;
    return Boolean(rooms && typeof rooms.has === 'function' && rooms.has(nomeSalaSocket(roomId)));
  }

  function iniciarEntrada(roomId) {
    const tentativa = { roomId, cancelada: false };
    entradaPendente = tentativa;
    return tentativa;
  }

  function entradaAindaValida(tentativa) {
    return entradaPendente === tentativa
      && !tentativa.cancelada
      && Boolean(manager.getSocketRole(socket.id, tentativa.roomId))
      && pertenceASala(socket.id, tentativa.roomId);
  }

  function concluirEntrada(tentativa) {
    if (entradaPendente === tentativa) entradaPendente = null;
  }

  function cancelarEntradaPendente() {
    if (entradaPendente) entradaPendente.cancelada = true;
  }

  function avisarEncerramento(result) {
    const nomeSala = nomeSalaSocket(result.roomId);
    for (const presenter of result.presenters) {
      io.to(nomeSala).emit('sala:transmissao', {
        salaId: result.roomId,
        isLive: false,
        presenterSocketId: null,
        presenterName: null,
        presenters: [],
        previousPresenterSocketId: presenter.socketId,
        previousPresenterName: presenter.name,
      });
    }
    io.to(nomeSala).emit('sala:encerrada', { salaId: result.roomId });
    removerMembrosDaSala(nomeSala, [result.hostSocketId, ...result.viewerSocketIds], true);
    publicarSalas();
  }

  function avisarSaidaDoEspectador(result, socketId) {
    const nomeSala = nomeSalaSocket(result.roomId);
    removerMembrosDaSala(nomeSala, [socketId]);
    if (result.transmissionStopped) {
      io.to(nomeSala).emit('sala:transmissao', {
        salaId: result.roomId,
        isLive: result.room.isLive,
        presenterSocketId: result.presenterSocketId,
        presenterName: result.presenterName,
        presenters: result.presenters,
        previousPresenterSocketId: result.previousPresenterSocketId,
        previousPresenterName: result.previousPresenterName,
      });
    }
    const notifyIds = result.presenters.length
      ? result.presenters.map((presenter) => presenter.socketId)
      : [result.hostSocketId];
    for (const notifyId of notifyIds) {
      if (notifyId && notifyId !== socketId) {
        io.to(notifyId).emit('sala:espectador-saiu', { salaId: result.roomId, socketId });
      }
    }
    if (result.room) {
      io.to(nomeSala).emit('sala:estado', { sala: result.room });
    }
    publicarSalas();
  }

  function reverterEntradaFalha(nomeSala) {
    const result = manager.leaveRoom(socket.id);
    if (!result.ok) {
      removerMembrosDaSala(nomeSala, [socket.id]);
      return;
    }
    if (result.closed) avisarEncerramento(result);
    else avisarSaidaDoEspectador(result, socket.id);
  }

  function rejeitarEntradaConcluida(tentativa, nomeSala, callback, mensagem) {
    concluirEntrada(tentativa);
    if (manager.getSocketRole(socket.id, tentativa.roomId)) {
      reverterEntradaFalha(nomeSala);
    } else {
      removerMembrosDaSala(nomeSala, [socket.id]);
    }
    reply(callback, { ok: false, error: mensagem });
  }

  function sairDaSala() {
    cancelarEntradaPendente();
    const result = manager.leaveRoom(socket.id);
    if (!result.ok) {
      const roomId = entradaPendente?.roomId;
      if (roomId) removerMembrosDaSala(nomeSalaSocket(roomId), [socket.id]);
      return result;
    }
    if (result.closed) {
      avisarEncerramento(result);
    } else {
      avisarSaidaDoEspectador(result, socket.id);
    }
    return result;
  }

  function desconectarSocket() {
    cancelarEntradaPendente();
    const result = manager.disconnectHost(socket.id, avisarEncerramento);
    if (!result) return sairDaSala();

    const nomeSala = nomeSalaSocket(result.roomId);
    if (result.transmissionStopped) {
      io.to(nomeSala).emit('sala:transmissao', {
        salaId: result.roomId,
        isLive: result.room.isLive,
        presenterSocketId: result.presenterSocketId,
        presenterName: result.presenterName,
        presenters: result.presenters,
        previousPresenterSocketId: result.previousPresenterSocketId,
        previousPresenterName: result.previousPresenterName,
      });
    }
    io.to(nomeSala).emit('sala:estado', {
      sala: {
        ...result.room,
        presenterSocketId: result.presenterSocketId,
        presenterName: result.presenterName,
      },
    });
    publicarSalas();
    return result;
  }

  socket.on('salas:listar', (_dados, callback) => {
    reply(callback, { ok: true, rooms: manager.listPublicRooms() });
  });

  socket.on('salas:criar', (dados, callback) => {
    dados = objetoOuVazio(dados);
    if (entradaPendente) {
      reply(callback, { ok: false, error: 'Sua entrada em uma sala ainda está sendo processada.' });
      return;
    }
    if (socket.espectadorAnonimo || !socket.usuario?.id) {
      reply(callback, { ok: false, error: 'É necessário entrar na conta para criar uma sala.' });
      return;
    }
    const result = manager.createRoom({
      ownerSocketId: socket.id,
      ownerId: socket.usuario.id,
      ownerName: socket.usuario.nome,
      name: dados.name,
      visibility: dados.visibility,
    });
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    const tentativa = iniciarEntrada(result.room.id);
    Promise.resolve().then(() => socket.join(nomeSalaSocket(result.room.id))).then(() => {
      if (!entradaAindaValida(tentativa)) {
        rejeitarEntradaConcluida(
          tentativa,
          nomeSalaSocket(result.room.id),
          callback,
          'A conexão foi encerrada antes de abrir a sala.',
        );
        return;
      }
      concluirEntrada(tentativa);
      reply(callback, result);
      publicarSalas();
    }, () => {
      concluirEntrada(tentativa);
      reverterEntradaFalha(nomeSalaSocket(result.room.id));
      reply(callback, { ok: false, error: 'Não foi possível abrir a sala.' });
    });
  });

  socket.on('salas:entrar', (dados, callback) => {
    dados = objetoOuVazio(dados);
    if (entradaPendente) {
      reply(callback, { ok: false, error: 'Sua entrada em uma sala ainda está sendo processada.' });
      return;
    }
    const salaIdSolicitada = dados.roomId || manager.resolvePrivateRoomId(dados.accessCode);
    const roleBeforeJoin = salaIdSolicitada
      ? manager.getSocketRole(socket.id, salaIdSolicitada)
      : null;
    const result = manager.joinRoom({
      roomId: salaIdSolicitada,
      socketId: socket.id,
      userId: socket.usuario?.id ?? null,
      userName: socket.usuario?.nome ?? (socket.espectadorAnonimo ? 'Visitante' : 'Espectador'),
      accessCode: dados.accessCode,
    });
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    const roomId = result.room.id;
    if (roleBeforeJoin && pertenceASala(socket.id, roomId)) {
      reply(callback, result);
      return;
    }
    const hostReconnected = Boolean(result.hostReconnected);
    const tentativa = iniciarEntrada(roomId);
    Promise.resolve().then(() => socket.join(nomeSalaSocket(roomId))).then(() => {
      if (!entradaAindaValida(tentativa)) {
        rejeitarEntradaConcluida(
          tentativa,
          nomeSalaSocket(roomId),
          callback,
          'A conexão foi encerrada antes de entrar na sala.',
        );
        return;
      }
      const resultadoAtualizado = manager.joinRoom({
        roomId,
        socketId: socket.id,
        userId: socket.usuario?.id ?? null,
        userName: socket.usuario?.nome ?? (socket.espectadorAnonimo ? 'Visitante' : 'Espectador'),
        accessCode: dados.accessCode,
      });
      if (!resultadoAtualizado.ok) {
        rejeitarEntradaConcluida(tentativa, nomeSalaSocket(roomId), callback, resultadoAtualizado.error);
        return;
      }
      resultadoAtualizado.hostReconnected = hostReconnected;
      concluirEntrada(tentativa);
      reply(callback, resultadoAtualizado);
      socket.emit('sala:youtube:estado', {
        salaId: roomId,
        source: resultadoAtualizado.youtubeSource,
        playback: resultadoAtualizado.youtubePlayback,
      });
      if (resultadoAtualizado.role === 'viewer' && !roleBeforeJoin) {
        const notifyIds = resultadoAtualizado.presenters.length
          ? resultadoAtualizado.presenters.map((presenter) => presenter.socketId)
          : [resultadoAtualizado.hostSocketId];
        for (const notifyId of notifyIds) {
          if (notifyId !== socket.id) {
            io.to(notifyId).emit('sala:espectador-entrou', { salaId: roomId, socketId: socket.id });
          }
        }
      }
      const estadoDaSala = {
        ...resultadoAtualizado.room,
        presenterSocketId: resultadoAtualizado.presenterSocketId,
        presenterName: resultadoAtualizado.presenterName,
      };
      if (hostReconnected) {
        io.to(nomeSalaSocket(roomId)).emit('sala:transmissao', {
          salaId: roomId,
          isLive: resultadoAtualizado.room.isLive,
          presenterSocketId: resultadoAtualizado.presenterSocketId,
          presenterName: resultadoAtualizado.presenterName,
          presenters: resultadoAtualizado.presenters,
        });
        io.to(nomeSalaSocket(roomId)).emit('sala:estado', { sala: estadoDaSala });
      } else {
        socket.emit('sala:estado', { sala: estadoDaSala });
      }
      publicarSalas();
    }, () => {
      concluirEntrada(tentativa);
      reverterEntradaFalha(nomeSalaSocket(roomId));
      reply(callback, { ok: false, error: 'Não foi possível entrar na sala.' });
    });
  });

  socket.on('sala:espectador-pronto', (dados, callback) => {
    dados = objetoOuVazio(dados);
    if (!dados.roomId || entradaPendente?.roomId === dados.roomId
      || !manager.getSocketRole(socket.id, dados.roomId)
      || !pertenceASala(socket.id, dados.roomId)) {
      reply(callback, { ok: false, error: 'Entre na sala antes de receber a transmissão.' });
      return;
    }

    const presenters = manager.getPresenters(dados.roomId);
    for (const presenter of presenters) {
      if (presenter.socketId !== socket.id) {
        io.to(presenter.socketId).emit('sala:espectador-entrou', { salaId: dados.roomId, socketId: socket.id });
      }
    }
    reply(callback, { ok: true, presenterSocketId: presenters[0]?.socketId ?? null, presenters });
  });

  socket.on('salas:ao-vivo', (dados, callback) => {
    dados = objetoOuVazio(dados);
    if (entradaPendente?.roomId === dados.roomId || !pertenceASala(socket.id, dados.roomId)) {
      reply(callback, { ok: false, error: 'Entre na sala antes de controlar a transmissão.' });
      return;
    }
    const result = manager.setLive(dados.roomId, socket.id, dados.isLive);
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    io.to(nomeSalaSocket(dados.roomId)).emit('sala:transmissao', {
      salaId: dados.roomId,
      isLive: result.room.isLive,
      presenterSocketId: result.presenterSocketId,
      presenterName: result.presenterName,
      presenters: result.presenters,
      previousPresenterSocketId: result.previousPresenterSocketId,
      previousPresenterName: result.previousPresenterName,
    });
    io.to(nomeSalaSocket(dados.roomId)).emit('sala:estado', { sala: result.room });
    publicarSalas();
    reply(callback, result);
  });

  socket.on('sala:youtube:fonte', (dados, callback) => {
    dados = objetoOuVazio(dados);
    const roomId = dados.roomId;
    if (!roomId || entradaPendente?.roomId === roomId
      || !manager.getSocketRole(socket.id, roomId)
      || !pertenceASala(socket.id, roomId)) {
      reply(callback, { ok: false, error: 'Entre na sala antes de alterar a fonte do YouTube.' });
      return;
    }
    const result = manager.setYoutubeSource(roomId, socket.id, dados.videoId);
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    io.to(nomeSalaSocket(roomId)).emit('sala:youtube:estado', {
      salaId: roomId,
      source: result.source,
      playback: result.playback,
    });
    reply(callback, result);
  });

  socket.on('sala:youtube:reproducao', (dados, callback) => {
    dados = objetoOuVazio(dados);
    const roomId = dados.roomId;
    if (!roomId || entradaPendente?.roomId === roomId
      || !manager.getSocketRole(socket.id, roomId)
      || !pertenceASala(socket.id, roomId)) {
      reply(callback, { ok: false, error: 'Entre na sala antes de controlar o vídeo.' });
      return;
    }
    const result = manager.setYoutubePlayback(roomId, socket.id, {
      action: dados.action,
      currentTime: dados.currentTime,
    });
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    io.to(nomeSalaSocket(roomId)).emit('sala:youtube:reproducao', {
      salaId: roomId,
      playback: result.playback,
    });
    reply(callback, result);
  });

  socket.on('salas:encerrar', (dados, callback) => {
    dados = objetoOuVazio(dados);
    const result = manager.endRoom(dados.roomId, socket.id);
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    reply(callback, result);
    avisarEncerramento(result);
  });

  socket.on('salas:sair', (_dados, callback) => reply(callback, sairDaSala()));

  const relays = [
    ['oferta', 'descricao'],
    ['resposta', 'resposta'],
    ['candidato', 'candidato'],
  ];
  relays.forEach(([signalType, payloadKey]) => {
    socket.on(`sala:sinal:${signalType}`, (dados, callback) => {
      dados = objetoOuVazio(dados);
      if (!dados.roomId || typeof dados.para !== 'string' || !dados.dados && !dados[payloadKey]) {
        reply(callback, { ok: false, error: 'Sinalização inválida.' });
        return;
      }
      const streamId = manager.resolveStreamId(dados.roomId, dados.streamId, {
        fromSocketId: socket.id,
        toSocketId: dados.para,
        signalType: { oferta: 'offer', resposta: 'answer', candidato: 'candidate' }[signalType],
      });
      if (!streamId) {
        reply(callback, { ok: false, error: 'Transmissão inválida ou ambígua.' });
        return;
      }
      const permitido = manager.canSignal({
        roomId: dados.roomId,
        fromSocketId: socket.id,
        toSocketId: dados.para,
        signalType: { oferta: 'offer', resposta: 'answer', candidato: 'candidate' }[signalType],
        streamId,
      });
      if (!permitido) {
        reply(callback, { ok: false, error: 'Este destino não pertence à sua sala.' });
        return;
      }
      if (entradaPendente || !pertenceASala(socket.id, dados.roomId) || !pertenceASala(dados.para, dados.roomId)) {
        reply(callback, { ok: false, error: 'Este destino não está conectado à sala.' });
        return;
      }
      const payload = dados[payloadKey] ?? dados.dados;
      io.to(dados.para).emit(`sala:sinal:${signalType}`, {
        roomId: dados.roomId, de: socket.id, streamId, [payloadKey]: payload,
      });
      reply(callback, { ok: true, streamId });
    });
  });

  socket.on('disconnect', desconectarSocket);
}

module.exports = {
  createStreamRoomManager,
  registerStreamRoomEvents: registrarEventosSala,
};
