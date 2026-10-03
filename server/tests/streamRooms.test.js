const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStreamRoomManager, registerStreamRoomEvents } = require('../streamRooms');

function managerDeTeste() {
  let id = 0;
  return createStreamRoomManager({
    makeId: () => `room-${++id}`,
    makeCode: () => 'ABCD2345',
  });
}

function criarSala(manager, options = {}) {
  return manager.createRoom({
    ownerSocketId: 'host-socket',
    ownerId: 1,
    ownerName: 'Anfitrião',
    name: '  Sessão de jogo  ',
    visibility: 'public',
    ...options,
  });
}

function socketDeTeste(id, usuario = null, espectadorAnonimo = false, join = null) {
  const handlers = new Map();
  const salasSocket = new Set();
  return {
    id,
    usuario,
    espectadorAnonimo,
    handlers,
    salasSocket,
    rooms: salasSocket,
    on: (evento, handler) => handlers.set(evento, handler),
    join: (room) => join ? join(room, salasSocket) : salasSocket.add(room),
    leave: (room) => salasSocket.delete(room),
    emit: () => {},
  };
}

function ioDeTeste() {
  const enviados = [];
  const io = {
    enviados,
    sockets: new Map(),
    emit: (evento, dados) => enviados.push({ destino: 'todos', evento, dados }),
    to: (destino) => ({ emit: (evento, dados) => enviados.push({ destino, evento, dados }) }),
    in: (destino) => ({
      socketsLeave: (room) => {
        const alvos = destino === room
          ? Array.from(io.sockets.values()).filter((candidate) => candidate.rooms?.has(room))
          : [io.sockets.get(destino)].filter(Boolean);
        alvos.forEach((candidate) => candidate.rooms?.delete(room));
      },
    }),
  };
  return io;
}

function registrarSocket(socket, io, manager) {
  io.sockets.set(socket.id, socket);
  registerStreamRoomEvents({ socket, io: { ...io, sockets: { sockets: io.sockets } }, manager });
}

function acionar(socket, evento, dados) {
  const handler = socket.handlers.get(evento);
  assert.ok(handler, `evento ${evento} não foi registrado`);
  return new Promise((resolve) => handler(dados, resolve));
}

test('screen room: cria salas públicas e privadas sem expor o código privado', () => {
  const manager = managerDeTeste();
  const publicRoom = criarSala(manager);
  const privateRoom = criarSala(manager, {
    ownerSocketId: 'host-2', ownerId: 2, name: 'Equipe', visibility: 'private',
  });

  assert.equal(publicRoom.ok, true);
  assert.equal(publicRoom.room.name, 'Sessão de jogo');
  assert.equal(publicRoom.role, 'host');
  assert.equal(publicRoom.accessCode, undefined);
  assert.equal(privateRoom.ok, true);
  assert.equal(privateRoom.accessCode, 'ABCD2345');
  assert.equal(Object.hasOwn(privateRoom.room, 'accessCode'), false);
  manager.setLive(publicRoom.room.id, 'host-socket', true);
  assert.equal(Object.hasOwn(manager.listPublicRooms()[0], 'accessCode'), false);
});

test('screen room: só entra na sala privada com o código correto', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager, { visibility: 'private' });

  const denied = manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-bad', accessCode: 'WRONG234' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'Código de acesso inválido.');
  assert.equal(manager.getSocketRole('viewer-bad', created.room.id), null);

  const joined = manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-good', accessCode: ' abcd2345 ' });
  assert.equal(joined.ok, true);
  assert.equal(joined.role, 'viewer');
  assert.equal(joined.hostSocketId, 'host-socket');
  assert.deepEqual(joined.peerSocketIds, ['host-socket']);
});

test('screen room: descoberta lista apenas salas públicas ao vivo', () => {
  const manager = managerDeTeste();
  const publicRoom = criarSala(manager);
  const privateRoom = criarSala(manager, {
    ownerSocketId: 'host-2', ownerId: 2, name: 'Privada', visibility: 'private',
  });

  assert.deepEqual(manager.listPublicRooms(), []);
  assert.equal(manager.setLive(publicRoom.room.id, 'host-socket', true).ok, true);
  assert.equal(manager.setLive(privateRoom.room.id, 'host-2', true).ok, true);
  assert.deepEqual(manager.listPublicRooms().map((room) => room.id), [publicRoom.room.id]);

  const viewerJoin = manager.joinRoom({ roomId: publicRoom.room.id, socketId: 'viewer-1' });
  assert.equal(viewerJoin.room.viewerCount, 1);
  assert.equal(manager.listPublicRooms()[0].viewerCount, 1);
});

test('screen room: sinalização é limitada ao anfitrião e espectadores da mesma sala', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  const other = criarSala(manager, { ownerSocketId: 'other-host', ownerId: 2, name: 'Outra sala' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-1' });
  manager.setLive(created.room.id, 'host-socket', true);

  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'host-socket', toSocketId: 'viewer-1', signalType: 'offer' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'viewer-1', toSocketId: 'host-socket', signalType: 'answer' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'viewer-1', toSocketId: 'host-socket', signalType: 'candidate' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'viewer-1', toSocketId: 'host-socket', signalType: 'offer' }), false);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'host-socket', toSocketId: 'other-host', signalType: 'offer' }), false);
  assert.equal(manager.canSignal({ roomId: other.room.id, fromSocketId: 'host-socket', toSocketId: 'viewer-1', signalType: 'candidate' }), false);
});

test('screen room: sair como espectador preserva a sala; sair como anfitrião a encerra', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-1' });

  const viewerLeft = manager.leaveRoom('viewer-1');
  assert.equal(viewerLeft.closed, false);
  assert.equal(manager.getRoom(created.room.id).viewerCount, 0);

  const hostLeft = manager.leaveRoom('host-socket');
  assert.equal(hostLeft.closed, true);
  assert.equal(manager.getRoom(created.room.id), null);
  assert.equal(manager.getSocketRole('viewer-1', created.room.id), null);
});

test('screen room: valida nome, visibilidade e autoridade para encerrar/ao vivo', () => {
  const manager = managerDeTeste();
  assert.equal(criarSala(manager, { name: '   ' }).ok, false);
  assert.equal(criarSala(manager, { name: 'x'.repeat(61) }).ok, false);
  assert.equal(criarSala(manager, { visibility: 'listed' }).ok, false);

  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-1' });
  assert.equal(manager.setLive(created.room.id, 'viewer-1', true).ok, false);
  assert.equal(manager.endRoom(created.room.id, 'viewer-1').ok, false);
  assert.equal(manager.endRoom(created.room.id, 'host-socket').ok, true);
});

test('screen room socket: visitante lista e entra, mas não cria sala', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Amigos', visibility: 'private' });

  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(viewer, io, manager);
  const listed = await acionar(viewer, 'salas:listar');
  assert.deepEqual(listed.rooms, []);
  const createDenied = await acionar(viewer, 'salas:criar', { name: 'Não permitido', visibility: 'public' });
  assert.equal(createDenied.ok, false);

  const joined = await acionar(viewer, 'salas:entrar', { roomId: created.room.id, accessCode: created.accessCode });
  assert.equal(joined.ok, true);
  assert.equal(joined.role, 'viewer');
  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), true);
  assert.ok(io.enviados.some((item) => item.destino === 'host-socket' && item.evento === 'sala:espectador-entrou'));
});

test('screen room socket: só retransmite oferta e resposta válidas entre peers da sala', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const outsider = socketDeTeste('outsider-socket', { id: 2, nome: 'Fora' });
  registrarSocket(host, io, manager);
  registrarSocket(outsider, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Ao vivo', visibility: 'public' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(viewer, io, manager);
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  await acionar(host, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });

  const oferta = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: 'viewer-socket', descricao: { type: 'offer', sdp: 'screen' },
  });
  assert.equal(oferta.ok, true);
  assert.ok(io.enviados.some((item) => item.destino === 'viewer-socket' && item.evento === 'sala:sinal:oferta'));

  const ofertaProibida = await acionar(viewer, 'sala:sinal:oferta', {
    roomId: created.room.id, para: 'host-socket', descricao: { type: 'offer' },
  });
  assert.equal(ofertaProibida.ok, false);
  const foraDaSala = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: 'outsider-socket', descricao: { type: 'offer' },
  });
  assert.equal(foraDaSala.ok, false);
  assert.equal(io.enviados.some((item) => item.destino === 'outsider-socket' && item.evento === 'sala:sinal:oferta'), false);

  const resposta = await acionar(viewer, 'sala:sinal:resposta', {
    roomId: created.room.id, para: 'host-socket', resposta: { type: 'answer', sdp: 'screen' },
  });
  assert.equal(resposta.ok, true);
});

test('screen room socket: saída do anfitrião encerra sala e remove espectadores', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  registrarSocket(viewer, io, manager);
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  host.handlers.get('disconnect')();
  assert.equal(manager.getRoom(created.room.id), null);
  assert.ok(io.enviados.some((item) => item.evento === 'sala:encerrada'));
  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), false);
});

test('screen room socket: falha síncrona ao criar remove sala e associação do socket', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' }, false, (room, rooms) => {
    rooms.add(room);
    throw new Error('adapter failed');
  });
  registrarSocket(host, io, manager);

  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });

  assert.equal(created.ok, false);
  assert.equal(manager.getRoom('room-1'), null);
  assert.equal(manager.getSocketRole(host.id, 'room-1'), null);
  assert.equal(host.salasSocket.has('sala-room-1'), false);
});

test('screen room socket: não confirma criação se join conclui sem associar o socket à sala', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' }, false, () => undefined);
  registrarSocket(host, io, manager);

  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });

  assert.equal(created.ok, false);
  assert.equal(manager.getRoom('room-1'), null);
  assert.equal(host.salasSocket.has('sala-room-1'), false);
});

test('screen room socket: rejeição assíncrona ao criar encerra membros admitidos durante a entrada', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  let rejeitarEntrada;
  let sinalizarInicio;
  const inicioEntrada = new Promise((resolve) => { sinalizarInicio = resolve; });
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' }, false, (room, rooms) => {
    rooms.add(room);
    sinalizarInicio();
    return new Promise((_resolve, reject) => { rejeitarEntrada = reject; });
  });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);

  const createPromise = acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await inicioEntrada;
  const joined = await acionar(viewer, 'salas:entrar', { roomId: 'room-1' });
  assert.equal(joined.ok, true);
  rejeitarEntrada(new Error('adapter failed'));

  const created = await createPromise;
  assert.equal(created.ok, false);
  assert.equal(manager.getRoom('room-1'), null);
  assert.equal(manager.getSocketRole(viewer.id, 'room-1'), null);
  assert.equal(host.salasSocket.has('sala-room-1'), false);
  assert.equal(viewer.salasSocket.has('sala-room-1'), false);
  assert.ok(io.enviados.some((item) => item.evento === 'sala:encerrada'));
});

test('screen room socket: falha ao entrar remove associação parcial e corrige estado do anfitrião', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true, (room, rooms) => {
    rooms.add(room);
    return Promise.reject(new Error('adapter failed'));
  });
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  io.enviados.length = 0;

  const joined = await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  assert.equal(joined.ok, false);
  assert.equal(manager.getSocketRole(viewer.id, created.room.id), null);
  assert.equal(manager.getRoom(created.room.id).viewerCount, 0);
  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), false);
  assert.ok(io.enviados.some((item) => item.destino === host.id && item.evento === 'sala:espectador-saiu'));
  assert.ok(io.enviados.some((item) => item.destino === `sala-${created.room.id}` && item.evento === 'sala:estado' && item.dados.sala.viewerCount === 0));
  assert.equal(io.enviados.some((item) => item.evento === 'sala:espectador-entrou'), false);
});

test('screen room socket: falha síncrona ao entrar não escapa do handler nem deixa membro fantasma', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true, () => {
    throw new Error('adapter failed');
  });
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });

  const joined = await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  assert.equal(joined.ok, false);
  assert.equal(manager.getSocketRole(viewer.id, created.room.id), null);
  assert.equal(manager.getRoom(created.room.id).viewerCount, 0);
});

test('screen room socket: conclusão tardia de join após disconnect não ressuscita associação', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  let concluirJoin;
  let sinalizarInicio;
  const inicioJoin = new Promise((resolve) => { sinalizarInicio = resolve; });
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' }, false, (room, rooms) => {
    sinalizarInicio();
    return new Promise((resolve) => {
      concluirJoin = () => {
        rooms.add(room);
        resolve();
      };
    });
  });
  registrarSocket(host, io, manager);

  const createPromise = acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await inicioJoin;
  host.handlers.get('disconnect')();
  concluirJoin();
  const created = await createPromise;

  assert.equal(created.ok, false);
  assert.equal(manager.getRoom('room-1'), null);
  assert.equal(host.salasSocket.has('sala-room-1'), false);
});

test('screen room socket: encerrar explicitamente remove todos os sockets do canal da sala', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  const ended = await acionar(host, 'salas:encerrar', { roomId: created.room.id });

  assert.equal(ended.closed, true);
  assert.equal(host.salasSocket.has(`sala-${created.room.id}`), false);
  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), false);
});

test('screen room socket: encerramento limpa associação restante mesmo se leave falhar', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  viewer.leave = () => { throw new Error('adapter failed'); };
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  await acionar(host, 'salas:encerrar', { roomId: created.room.id });

  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), false);
});

test('screen room socket: não retransmite sinal para socket desconectado com associação residual', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Ao vivo', visibility: 'public' });
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  await acionar(host, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.sockets.delete(viewer.id);

  const signal = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: viewer.id, descricao: { type: 'offer', sdp: 'screen' },
  });

  assert.equal(signal.ok, false);
  assert.equal(io.enviados.some((item) => item.destino === viewer.id && item.evento === 'sala:sinal:oferta'), false);
});

test('screen room socket: exige que ambos os peers ainda estejam na sala do adapter', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(viewer, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Ao vivo', visibility: 'public' });
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  await acionar(host, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });

  viewer.rooms.delete(`sala-${created.room.id}`);
  const targetNotInAdapterRoom = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: viewer.id, descricao: { type: 'offer' },
  });
  assert.equal(targetNotInAdapterRoom.ok, false);

  viewer.rooms.add(`sala-${created.room.id}`);
  host.rooms.delete(`sala-${created.room.id}`);
  const senderNotInAdapterRoom = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: viewer.id, descricao: { type: 'offer' },
  });
  assert.equal(senderNotInAdapterRoom.ok, false);
});

test('screen room socket: payloads nulos recebem erro em vez de escapar dos handlers', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  registrarSocket(host, io, manager);

  for (const evento of ['salas:criar', 'salas:entrar', 'salas:ao-vivo', 'salas:encerrar', 'sala:sinal:oferta']) {
    const resultado = await acionar(host, evento, null);
    assert.equal(resultado.ok, false, `${evento} deve rejeitar payload nulo`);
  }
});
