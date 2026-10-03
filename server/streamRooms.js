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
    viewerCount: sala.viewers.size,
    createdAt: sala.createdAt,
  };
}

function createStreamRoomManager({ makeId = randomUUID, makeCode = gerarCodigo } = {}) {
  const salas = new Map();
  const salasPorSocket = new Map();

  function resultadoDeEntrada(sala, socketId, role) {
    const peerSocketIds = role === 'host'
      ? Array.from(sala.viewers.keys())
      : [sala.ownerSocketId];
    return {
      ok: true,
      room: criarResumoSala(sala),
      role,
      hostSocketId: sala.ownerSocketId,
      peerSocketIds,
      ...(role === 'host' && sala.accessCode ? { accessCode: sala.accessCode } : {}),
    };
  }

  function createRoom({ ownerSocketId, ownerId, ownerName, name, visibility }) {
    const nome = typeof name === 'string' ? name.trim() : '';
    if (!ownerSocketId || ownerId == null) return { ok: false, error: 'É necessário entrar na conta para criar uma sala.' };
    if (salasPorSocket.has(ownerSocketId)) return { ok: false, error: 'Você já está em uma sala.' };
    if (!nome || nome.length > 60) return { ok: false, error: 'O nome deve ter entre 1 e 60 caracteres.' };
    if (visibility !== 'public' && visibility !== 'private') return { ok: false, error: 'Escolha se a sala será pública ou privada.' };

    const id = makeId();
    if (!id || salas.has(id)) return { ok: false, error: 'Não foi possível criar um identificador de sala.' };
    const sala = {
      id,
      name: nome,
      ownerId,
      ownerName: typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim().slice(0, 32) : 'Anfitrião',
      ownerSocketId,
      visibility,
      accessCode: visibility === 'private' ? makeCode() : null,
      isLive: false,
      viewers: new Map(),
      createdAt: new Date().toISOString(),
    };
    salas.set(id, sala);
    salasPorSocket.set(ownerSocketId, { roomId: id, role: 'host' });
    return { ok: true, room: criarResumoSala(sala), role: 'host', peerSocketIds: [], ...(sala.accessCode ? { accessCode: sala.accessCode } : {}) };
  }

  function joinRoom({ roomId, socketId, userId = null, accessCode }) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    if (!socketId) return { ok: false, error: 'Conexão inválida.' };

    const membership = salasPorSocket.get(socketId);
    if (membership) {
      if (membership.roomId !== roomId) return { ok: false, error: 'Saia da outra sala antes de entrar nesta.' };
      return resultadoDeEntrada(sala, socketId, membership.role);
    }
    if (sala.accessCode && !compararCodigo(accessCode, sala.accessCode)) {
      return { ok: false, error: 'Código de acesso inválido.' };
    }

    const role = socketId === sala.ownerSocketId ? 'host' : 'viewer';
    if (role === 'viewer') sala.viewers.set(socketId, { userId });
    salasPorSocket.set(socketId, { roomId, role });
    return resultadoDeEntrada(sala, socketId, role);
  }

  function setLive(roomId, socketId, isLive) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    if (sala.ownerSocketId !== socketId || salasPorSocket.get(socketId)?.role !== 'host') {
      return { ok: false, error: 'Somente o anfitrião pode controlar a transmissão.' };
    }
    sala.isLive = Boolean(isLive);
    return { ok: true, room: criarResumoSala(sala), peerSocketIds: Array.from(sala.viewers.keys()) };
  }

  function endRoom(roomId, socketId) {
    const sala = salas.get(roomId);
    if (!sala) return { ok: false, error: 'Esta sala não está mais ativa.' };
    if (sala.ownerSocketId !== socketId || salasPorSocket.get(socketId)?.role !== 'host') {
      return { ok: false, error: 'Somente o anfitrião pode encerrar a sala.' };
    }
    const viewerSocketIds = Array.from(sala.viewers.keys());
    salasPorSocket.delete(sala.ownerSocketId);
    viewerSocketIds.forEach((viewerSocketId) => salasPorSocket.delete(viewerSocketId));
    salas.delete(roomId);
    return { ok: true, closed: true, roomId, hostSocketId: sala.ownerSocketId, viewerSocketIds };
  }

  function leaveRoom(socketId) {
    const membership = salasPorSocket.get(socketId);
    if (!membership) return { ok: false, error: 'Você não está em uma sala.' };
    if (membership.role === 'host') return endRoom(membership.roomId, socketId);

    const sala = salas.get(membership.roomId);
    salasPorSocket.delete(socketId);
    sala?.viewers.delete(socketId);
    return {
      ok: true,
      closed: false,
      roomId: membership.roomId,
      hostSocketId: sala?.ownerSocketId,
      room: sala ? criarResumoSala(sala) : null,
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

  function canSignal({ roomId, fromSocketId, toSocketId, signalType }) {
    const sala = salas.get(roomId);
    if (!sala || !sala.isLive || fromSocketId === toSocketId) return false;
    const fromRole = getSocketRole(fromSocketId, roomId);
    const toRole = getSocketRole(toSocketId, roomId);
    if (!fromRole || !toRole || fromRole === toRole) return false;

    if (signalType === 'candidate') return true;
    if (signalType === 'offer') return fromRole === 'host' && toRole === 'viewer';
    if (signalType === 'answer') return fromRole === 'viewer' && toRole === 'host';
    return false;
  }

  return {
    createRoom,
    joinRoom,
    setLive,
    endRoom,
    leaveRoom,
    getRoom,
    getSocketRole,
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
    io.to(nomeSala).emit('sala:encerrada', { salaId: result.roomId });
    removerMembrosDaSala(nomeSala, [result.hostSocketId, ...result.viewerSocketIds], true);
    publicarSalas();
  }

  function avisarSaidaDoEspectador(result, socketId) {
    removerMembrosDaSala(nomeSalaSocket(result.roomId), [socketId]);
    if (result.hostSocketId) {
      io.to(result.hostSocketId).emit('sala:espectador-saiu', { salaId: result.roomId, socketId });
    }
    if (result.room) {
      io.to(nomeSalaSocket(result.roomId)).emit('sala:estado', { sala: result.room });
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
    const roleBeforeJoin = manager.getSocketRole(socket.id, dados.roomId);
    const result = manager.joinRoom({
      roomId: dados.roomId,
      socketId: socket.id,
      userId: socket.usuario?.id ?? null,
      accessCode: dados.accessCode,
    });
    if (!result.ok) {
      reply(callback, result);
      return;
    }
    const tentativa = iniciarEntrada(dados.roomId);
    Promise.resolve().then(() => socket.join(nomeSalaSocket(dados.roomId))).then(() => {
      if (!entradaAindaValida(tentativa)) {
        rejeitarEntradaConcluida(
          tentativa,
          nomeSalaSocket(dados.roomId),
          callback,
          'A conexão foi encerrada antes de entrar na sala.',
        );
        return;
      }
      concluirEntrada(tentativa);
      reply(callback, result);
      if (result.role === 'viewer' && !roleBeforeJoin) {
        io.to(result.hostSocketId).emit('sala:espectador-entrou', { salaId: dados.roomId, socketId: socket.id });
      }
      socket.emit('sala:estado', { sala: result.room });
      publicarSalas();
    }, () => {
      concluirEntrada(tentativa);
      reverterEntradaFalha(nomeSalaSocket(dados.roomId));
      reply(callback, { ok: false, error: 'Não foi possível entrar na sala.' });
    });
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
    io.to(nomeSalaSocket(dados.roomId)).emit('sala:transmissao', { salaId: dados.roomId, isLive: result.room.isLive });
    io.to(nomeSalaSocket(dados.roomId)).emit('sala:estado', { sala: result.room });
    publicarSalas();
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
      const permitido = manager.canSignal({
        roomId: dados.roomId,
        fromSocketId: socket.id,
        toSocketId: dados.para,
        signalType: { oferta: 'offer', resposta: 'answer', candidato: 'candidate' }[signalType],
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
      io.to(dados.para).emit(`sala:sinal:${signalType}`, { roomId: dados.roomId, de: socket.id, [payloadKey]: payload });
      reply(callback, { ok: true });
    });
  });

  socket.on('disconnect', sairDaSala);
}

module.exports = {
  createStreamRoomManager,
  registerStreamRoomEvents: registrarEventosSala,
};
