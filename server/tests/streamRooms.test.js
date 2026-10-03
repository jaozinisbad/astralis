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

test('screen room: resolve apenas códigos de salas privadas que continuam ativas', () => {
  const manager = managerDeTeste();
  const privateRoom = criarSala(manager, { visibility: 'private' });
  const publicRoom = criarSala(manager, {
    ownerSocketId: 'host-2', ownerId: 2, name: 'Pública', visibility: 'public',
  });

  assert.equal(manager.resolvePrivateRoomId(' abcd2345 '), privateRoom.room.id);
  assert.equal(manager.resolvePrivateRoomId('WRONG234'), null);
  assert.equal(manager.resolvePrivateRoomId(''), null);
  assert.equal(manager.resolvePrivateRoomId(publicRoom.accessCode), null);

  manager.endRoom(privateRoom.room.id, 'host-socket');
  assert.equal(manager.resolvePrivateRoomId('ABCD2345'), null);
});

test('screen room: códigos privados repetidos geram outro código para manter a busca sem ambiguidade', () => {
  const codigos = ['ABCD2345', 'ABCD2345', 'EFGH2345'];
  let id = 0;
  const manager = createStreamRoomManager({
    makeId: () => `room-${++id}`,
    makeCode: () => codigos.shift(),
  });
  const primeira = criarSala(manager, { visibility: 'private' });
  const segunda = criarSala(manager, {
    ownerSocketId: 'host-2', ownerId: 2, name: 'Segunda', visibility: 'private',
  });

  assert.equal(primeira.accessCode, 'ABCD2345');
  assert.equal(segunda.accessCode, 'EFGH2345');
  assert.equal(manager.resolvePrivateRoomId('ABCD2345'), primeira.room.id);
  assert.equal(manager.resolvePrivateRoomId('EFGH2345'), segunda.room.id);
});

test('screen room: entrada por código resolve internamente a sala e preserva o sigilo das privadas', async () => {
  const manager = managerDeTeste();
  const created = criarSala(manager, { visibility: 'private' });
  manager.setLive(created.room.id, 'host-socket', true);
  const viewer = socketDeTeste('viewer-code-only', null, true);
  const io = ioDeTeste();
  registrarSocket(viewer, io, manager);

  const joined = await acionar(viewer, 'salas:entrar', { accessCode: ' abcd2345 ' });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.id, created.room.id);
  assert.equal(joined.role, 'viewer');
  assert.equal(viewer.salasSocket.has(`sala-${created.room.id}`), true);
  assert.deepEqual(manager.listPublicRooms(), []);
  assert.equal(io.enviados.some(({ evento, dados }) => evento === 'salas:atualizadas' && JSON.stringify(dados).includes('ABCD2345')), false);

  const invalidViewer = socketDeTeste('viewer-invalid-code', null, true);
  registrarSocket(invalidViewer, ioDeTeste(), manager);
  assert.deepEqual(
    await acionar(invalidViewer, 'salas:entrar', { accessCode: 'WRONG234' }),
    { ok: false, error: 'Código inválido ou sala encerrada.' },
  );
  assert.equal(invalidViewer.salasSocket.size, 0);
  assert.equal(manager.getSocketRole('viewer-invalid-code', created.room.id), null);
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

test('screen room: qualquer membro anônimo ou autenticado pode iniciar e recebe os demais peers', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'anonymous-presenter' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-two', userId: 2, userName: 'Ana' });

  const anonymousStart = manager.setLive(created.room.id, 'anonymous-presenter', true);

  assert.equal(anonymousStart.ok, true);
  assert.equal(anonymousStart.room.isLive, true);
  assert.equal(anonymousStart.presenterSocketId, 'anonymous-presenter');
  assert.equal(anonymousStart.presenterName, 'Visitante');
  assert.deepEqual(anonymousStart.peerSocketIds, ['host-socket', 'viewer-two']);
  assert.equal(manager.getSocketRole('anonymous-presenter', created.room.id), 'viewer');
  assert.equal(manager.setLive(created.room.id, 'anonymous-presenter', false).ok, true);

  const authenticatedStart = manager.setLive(created.room.id, 'viewer-two', true);
  assert.equal(authenticatedStart.ok, true);
  assert.equal(authenticatedStart.presenterSocketId, 'viewer-two');
  assert.equal(authenticatedStart.presenterName, 'Ana');
  assert.deepEqual(authenticatedStart.peerSocketIds, ['host-socket', 'anonymous-presenter']);
});

test('screen room: só um presenter ativo por sala e somente ele pode parar sua transmissão', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter-one', userId: 2, userName: 'Ana' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter-two', userId: 3, userName: 'Bia' });

  const started = manager.setLive(created.room.id, 'presenter-one', true);
  const competingStart = manager.setLive(created.room.id, 'presenter-two', true);
  const competingStop = manager.setLive(created.room.id, 'presenter-two', false);
  const hostStop = manager.setLive(created.room.id, 'host-socket', false);

  assert.equal(started.ok, true);
  assert.equal(competingStart.ok, false);
  assert.equal(competingStart.presenterSocketId, 'presenter-one');
  assert.equal(competingStop.ok, false);
  assert.equal(hostStop.ok, false);
  assert.equal(manager.getRoom(created.room.id).isLive, true);
  assert.equal(manager.setLive(created.room.id, 'presenter-one', false).ok, true);
  assert.equal(manager.getRoom(created.room.id).isLive, false);
});

test('screen room socket: disconnect do presenter encerra a transmissão, mas preserva a sala', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', null, true);
  const member = socketDeTeste('member-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  registrarSocket(member, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(member, 'salas:entrar', { roomId: created.room.id });
  assert.equal((await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true })).ok, true);

  io.enviados.length = 0;
  presenter.handlers.get('disconnect')();

  assert.equal(manager.getRoom(created.room.id).isLive, false);
  assert.equal(manager.getSocketRole(presenter.id, created.room.id), null);
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === `sala-${created.room.id}`
    && evento === 'sala:transmissao'
    && dados.isLive === false
    && dados.presenterSocketId === null
    && dados.presenterName === null
  )));
  assert.equal(manager.getSocketRole(host.id, created.room.id), 'host');
  assert.equal(manager.getSocketRole(member.id, created.room.id), 'viewer');
});

test('screen room socket: entrada atrasada não retorna presenter já desconectado', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', { id: 2, nome: 'Ana' });
  let concluirEntrada;
  let sinalizarEntrada;
  const inicioEntrada = new Promise((resolve) => { sinalizarEntrada = resolve; });
  const lateMember = socketDeTeste('late-member', null, true, (room, rooms) => {
    sinalizarEntrada();
    return new Promise((resolve) => {
      concluirEntrada = () => {
        rooms.add(room);
        resolve();
      };
    });
  });
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  registrarSocket(lateMember, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });

  const joinPromise = acionar(lateMember, 'salas:entrar', { roomId: created.room.id });
  await inicioEntrada;
  presenter.handlers.get('disconnect')();
  concluirEntrada();
  const joined = await joinPromise;

  assert.equal(joined.ok, true);
  assert.equal(joined.room.isLive, false);
  assert.equal(joined.presenterSocketId, null);
  assert.deepEqual(joined.peerSocketIds, [host.id]);
  assert.equal(io.enviados.some(({ destino, evento }) => (
    destino === presenter.id && evento === 'sala:espectador-entrou'
  )), false);
});

test('screen room socket: presenter controla live e entrada/saída de membros chega a ele', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', { id: 2, nome: 'Ana' });
  const member = socketDeTeste('member-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  registrarSocket(member, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'private' });
  await acionar(presenter, 'salas:entrar', { accessCode: created.accessCode });
  const started = await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });

  assert.equal(started.ok, true);
  assert.deepEqual(started.peerSocketIds, ['host-socket']);
  assert.equal(started.presenterSocketId, presenter.id);
  assert.equal(started.presenterName, 'Ana');
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === `sala-${created.room.id}`
    && evento === 'sala:transmissao'
    && dados.presenterSocketId === presenter.id
    && dados.presenterName === 'Ana'
  )));

  const offer = await acionar(presenter, 'sala:sinal:oferta', {
    roomId: created.room.id, para: host.id, descricao: { type: 'offer', sdp: 'screen' },
  });
  const answer = await acionar(host, 'sala:sinal:resposta', {
    roomId: created.room.id, para: presenter.id, resposta: { type: 'answer', sdp: 'screen' },
  });
  const memberOffer = await acionar(host, 'sala:sinal:oferta', {
    roomId: created.room.id, para: member.id, descricao: { type: 'offer', sdp: 'forbidden' },
  });
  assert.equal(offer.ok, true);
  assert.equal(answer.ok, true);
  assert.equal(memberOffer.ok, false);

  io.enviados.length = 0;
  const joined = await acionar(member, 'salas:entrar', { accessCode: created.accessCode });
  assert.equal(joined.presenterSocketId, presenter.id);
  assert.deepEqual(joined.peerSocketIds, [presenter.id]);
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === presenter.id && evento === 'sala:espectador-entrou' && dados.socketId === member.id
  )));

  io.enviados.length = 0;
  await acionar(member, 'salas:sair');
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === presenter.id && evento === 'sala:espectador-saiu' && dados.socketId === member.id
  )));

  io.enviados.length = 0;
  const stopped = await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: false });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.presenterSocketId, null);
  assert.equal(stopped.previousPresenterSocketId, presenter.id);
  assert.equal(manager.getRoom(created.room.id).isLive, false);
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === `sala-${created.room.id}`
    && evento === 'sala:transmissao'
    && dados.isLive === false
    && dados.presenterSocketId === null
    && dados.presenterName === null
    && dados.previousPresenterSocketId === presenter.id
    && dados.previousPresenterName === 'Ana'
  )));
});

test('screen room socket: participante já conectado pode avisar que está pronto e recuperar a oferta do presenter', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', { id: 2, nome: 'Ana' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  const outsider = socketDeTeste('outsider-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  registrarSocket(viewer, io, manager);
  registrarSocket(outsider, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  io.enviados.length = 0;

  const ready = await acionar(viewer, 'sala:espectador-pronto', { roomId: created.room.id });
  const outsiderResult = await acionar(outsider, 'sala:espectador-pronto', { roomId: created.room.id });

  assert.equal(ready.ok, true);
  assert.equal(ready.presenterSocketId, presenter.id);
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === presenter.id && evento === 'sala:espectador-entrou' && dados.socketId === viewer.id
  )));
  assert.equal(outsiderResult.ok, false);
  assert.equal(io.enviados.some(({ destino, evento, dados }) => (
    destino === presenter.id && evento === 'sala:espectador-entrou' && dados.socketId === outsider.id
  )), false);
});

test('screen room: só o presenter sinaliza ofertas e respostas aos peers conectados na mesma sala', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  const other = criarSala(manager, { ownerSocketId: 'other-host', ownerId: 2, name: 'Outra sala' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'member-one' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'member-two' });
  manager.joinRoom({ roomId: other.room.id, socketId: 'other-member' });
  manager.setLive(created.room.id, 'presenter', true);

  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'presenter', toSocketId: 'host-socket', signalType: 'offer' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'member-one', toSocketId: 'presenter', signalType: 'answer' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'presenter', toSocketId: 'member-one', signalType: 'candidate' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'member-one', toSocketId: 'presenter', signalType: 'candidate' }), true);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'host-socket', toSocketId: 'member-one', signalType: 'offer' }), false);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'member-one', toSocketId: 'member-two', signalType: 'answer' }), false);
  assert.equal(manager.canSignal({ roomId: created.room.id, fromSocketId: 'presenter', toSocketId: 'other-member', signalType: 'offer' }), false);
  assert.equal(manager.canSignal({ roomId: other.room.id, fromSocketId: 'presenter', toSocketId: 'other-member', signalType: 'candidate' }), false);
});

test('screen room: saída voluntária do presenter limpa o palco e mantém os outros membros', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;

  const left = await acionar(presenter, 'salas:sair');

  assert.equal(left.closed, false);
  assert.equal(left.transmissionStopped, true);
  assert.equal(manager.getRoom(created.room.id).isLive, false);
  assert.equal(manager.getSocketRole(host.id, created.room.id), 'host');
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === `sala-${created.room.id}`
    && evento === 'sala:transmissao'
    && dados.isLive === false
    && dados.previousPresenterSocketId === presenter.id
    && dados.previousPresenterName === 'Visitante'
  )));
});

test('screen room socket: anfitrião encerra a sala mesmo com presenter de membro ativo', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const presenter = socketDeTeste('presenter-socket', { id: 2, nome: 'Ana' });
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;

  const closed = await acionar(host, 'salas:encerrar', { roomId: created.room.id });

  assert.equal(closed.closed, true);
  assert.equal(closed.presenterSocketId, presenter.id);
  assert.equal(manager.getRoom(created.room.id), null);
  assert.ok(io.enviados.some(({ evento, dados }) => (
    evento === 'sala:transmissao' && dados.isLive === false && dados.previousPresenterSocketId === presenter.id
  )));
  assert.ok(io.enviados.some(({ evento }) => evento === 'sala:encerrada'));
  assert.equal(presenter.salasSocket.has(`sala-${created.room.id}`), false);
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

test('screen room: qualquer membro pode transmitir, mas só o anfitrião pode encerrar', () => {
  const manager = managerDeTeste();
  assert.equal(criarSala(manager, { name: '   ' }).ok, false);
  assert.equal(criarSala(manager, { name: 'x'.repeat(61) }).ok, false);
  assert.equal(criarSala(manager, { visibility: 'listed' }).ok, false);

  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'viewer-1' });
  assert.equal(manager.setLive(created.room.id, 'viewer-1', true).ok, true);
  assert.equal(manager.endRoom(created.room.id, 'viewer-1').ok, false);
  assert.equal(manager.endRoom(created.room.id, 'host-socket').ok, true);
  assert.equal(manager.getRoom(created.room.id), null);
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
