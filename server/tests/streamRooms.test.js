const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStreamRoomManager, registerStreamRoomEvents } = require('../streamRooms');

function managerDeTeste(options = {}) {
  let id = 0;
  return createStreamRoomManager({
    makeId: () => `room-${++id}`,
    makeCode: () => 'ABCD2345',
    ...options,
  });
}

function timersDeTeste() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay) {
      const timerId = ++id;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(timerId) { timers.delete(timerId); },
    executar() {
      const pendentes = [...timers.values()];
      timers.clear();
      pendentes.forEach(({ callback }) => callback());
    },
  };
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
  const recebidos = [];
  return {
    id,
    usuario,
    espectadorAnonimo,
    handlers,
    salasSocket,
    rooms: salasSocket,
    recebidos,
    on: (evento, handler) => handlers.set(evento, handler),
    join: (room) => join ? join(room, salasSocket) : salasSocket.add(room),
    leave: (room) => salasSocket.delete(room),
    emit: (evento, dados) => recebidos.push({ evento, dados }),
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

test('screen room socket: repetir entrada no mesmo socket é idempotente', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  const viewer = socketDeTeste('viewer-socket', null, true, (room, rooms) => {
    if (rooms.has(room)) throw new Error('duplicate socket join');
    rooms.add(room);
  });
  registrarSocket(viewer, io, manager);

  const firstJoin = await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  const repeatedJoin = await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  assert.equal(firstJoin.ok, true);
  assert.equal(repeatedJoin.ok, true);
  assert.equal(repeatedJoin.role, 'viewer');
  assert.equal(manager.getSocketRole(viewer.id, created.room.id), 'viewer');
  assert.equal(manager.getRoom(created.room.id).viewerCount, 1);
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

test('screen room: aceita dois presenters distintos, mantém legado do primeiro e rejeita o terceiro', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter-one', userId: 2, userName: 'Ana' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter-two', userId: 3, userName: 'Bia' });
  manager.joinRoom({ roomId: created.room.id, socketId: 'presenter-three', userId: 4, userName: 'Caio' });

  const first = manager.setLive(created.room.id, 'presenter-one', true);
  const second = manager.setLive(created.room.id, 'presenter-two', true);
  const repeated = manager.setLive(created.room.id, 'presenter-one', true);
  const third = manager.setLive(created.room.id, 'presenter-three', true);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.presenters, [
    { socketId: 'presenter-one', name: 'Ana' },
    { socketId: 'presenter-two', name: 'Bia' },
  ]);
  assert.deepEqual(manager.getRoom(created.room.id).presenters, second.presenters);
  assert.equal(second.presenterSocketId, 'presenter-one');
  assert.equal(second.presenterName, 'Ana');
  assert.deepEqual(repeated.presenters, second.presenters);
  assert.equal(third.ok, false);
  assert.deepEqual(manager.listPublicRooms()[0].presenters, second.presenters);

  const joined = manager.joinRoom({ roomId: created.room.id, socketId: 'late-viewer' });
  assert.deepEqual(joined.presenters, second.presenters);
  assert.deepEqual(joined.peerSocketIds, ['presenter-one', 'presenter-two']);
  assert.equal(manager.setLive(created.room.id, 'host-socket', false).ok, false);
  const stoppedFirst = manager.setLive(created.room.id, 'presenter-one', false);
  assert.equal(stoppedFirst.ok, true);
  assert.equal(stoppedFirst.room.isLive, true);
  assert.deepEqual(stoppedFirst.presenters, [{ socketId: 'presenter-two', name: 'Bia' }]);
  assert.equal(stoppedFirst.presenterSocketId, 'presenter-two');
  assert.equal(stoppedFirst.previousPresenterSocketId, 'presenter-one');
  assert.equal(manager.setLive(created.room.id, 'presenter-three', true).ok, true);
  assert.equal(manager.setLive(created.room.id, 'presenter-two', false).room.isLive, true);
  assert.equal(manager.setLive(created.room.id, 'presenter-three', false).room.isLive, false);
});

test('screen room socket: stopping or disconnecting one presenter keeps the other live', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const first = socketDeTeste('first', { id: 2, nome: 'Ana' });
  const second = socketDeTeste('second', { id: 3, nome: 'Bia' });
  [host, first, second].forEach((member) => registrarSocket(member, io, manager));
  const created = await acionar(host, 'salas:criar', { name: 'Duas telas', visibility: 'public' });
  await acionar(first, 'salas:entrar', { roomId: created.room.id });
  await acionar(second, 'salas:entrar', { roomId: created.room.id });
  await acionar(first, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  const started = await acionar(second, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  assert.deepEqual(started.presenters, [
    { socketId: first.id, name: 'Ana' }, { socketId: second.id, name: 'Bia' },
  ]);
  assert.ok(io.enviados.some(({ evento, dados }) => evento === 'sala:transmissao'
    && dados.presenters?.length === 2 && dados.presenterSocketId === first.id));

  io.enviados.length = 0;
  const stopped = await acionar(first, 'salas:ao-vivo', { roomId: created.room.id, isLive: false });
  assert.equal(stopped.room.isLive, true);
  assert.deepEqual(stopped.presenters, [{ socketId: second.id, name: 'Bia' }]);
  assert.ok(io.enviados.some(({ evento, dados }) => evento === 'sala:transmissao'
    && dados.isLive === true && dados.previousPresenterSocketId === first.id
    && dados.presenterSocketId === second.id && dados.presenters?.length === 1));

  await acionar(first, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;
  first.handlers.get('disconnect')();
  assert.deepEqual(manager.getRoom(created.room.id).presenters, [{ socketId: second.id, name: 'Bia' }]);
  assert.equal(manager.getRoom(created.room.id).isLive, true);
  assert.ok(io.enviados.some(({ evento, dados }) => evento === 'sala:transmissao'
    && dados.isLive === true && dados.previousPresenterSocketId === first.id
    && dados.presenters?.[0]?.socketId === second.id));
});

test('screen room: rejeita estado de transmissão que não seja booleano', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);

  const malformedStart = manager.setLive(created.room.id, 'host-socket', 'true');
  const malformedStop = manager.setLive(created.room.id, 'host-socket', 'false');

  assert.equal(malformedStart.ok, false);
  assert.equal(malformedStop.ok, false);
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
  const second = socketDeTeste('second-socket', { id: 2, nome: 'Bia' });
  registrarSocket(host, io, manager);
  registrarSocket(presenter, io, manager);
  registrarSocket(second, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  await acionar(presenter, 'salas:entrar', { roomId: created.room.id });
  await acionar(second, 'salas:entrar', { roomId: created.room.id });
  await acionar(presenter, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  await acionar(second, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;

  const left = await acionar(presenter, 'salas:sair');

  assert.equal(left.closed, false);
  assert.equal(left.transmissionStopped, true);
  assert.equal(manager.getRoom(created.room.id).isLive, true);
  assert.deepEqual(manager.getRoom(created.room.id).presenters, [{ socketId: second.id, name: 'Bia' }]);
  assert.equal(manager.getSocketRole(host.id, created.room.id), 'host');
  assert.ok(io.enviados.some(({ destino, evento, dados }) => (
    destino === `sala-${created.room.id}`
    && evento === 'sala:transmissao'
    && dados.isLive === true
    && dados.presenterSocketId === second.id
    && dados.presenters?.length === 1
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
  assert.equal(oferta.streamId, host.id);
  assert.ok(io.enviados.some((item) => item.destino === 'viewer-socket'
    && item.evento === 'sala:sinal:oferta' && item.dados.streamId === host.id));

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
  assert.equal(resposta.streamId, host.id);
  assert.ok(io.enviados.some((item) => item.destino === host.id
    && item.evento === 'sala:sinal:resposta' && item.dados.streamId === host.id));
});

test('screen room socket: anfitrião se reconecta após oscilação e a transmissão é restaurada', async () => {
  const timers = timersDeTeste();
  const manager = managerDeTeste({
    hostReconnectGraceMs: 15_000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'private' });
  registrarSocket(viewer, io, manager);
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id, accessCode: created.accessCode });
  await acionar(host, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });

  host.handlers.get('disconnect')();

  assert.equal(manager.getRoom(created.room.id).isLive, false);
  assert.equal(manager.getSocketRole(viewer.id, created.room.id), 'viewer');
  assert.equal(io.enviados.some((item) => item.evento === 'sala:encerrada'), false);

  const reconnectedHost = socketDeTeste('host-reconnected', { id: 1, nome: 'Anfitrião' });
  registrarSocket(reconnectedHost, io, manager);
  const joined = await acionar(reconnectedHost, 'salas:entrar', { roomId: created.room.id });

  assert.equal(joined.ok, true);
  assert.equal(joined.role, 'host');
  assert.equal(joined.room.isLive, true);
  assert.equal(joined.presenterSocketId, reconnectedHost.id);
  assert.deepEqual(joined.peerSocketIds, [viewer.id]);
  assert.equal(manager.getSocketRole(host.id, created.room.id), null);
  assert.equal(timers.timers.size, 0, 'reattach cancels the room expiry timer');
  timers.executar();
  assert.ok(manager.getRoom(created.room.id));
});

test('screen room socket: host reconnection restores only its stream beside the other presenter', async () => {
  const timers = timersDeTeste();
  const manager = managerDeTeste({
    hostReconnectGraceMs: 15_000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const second = socketDeTeste('second', { id: 2, nome: 'Bia' });
  const third = socketDeTeste('third', { id: 3, nome: 'Caio' });
  [host, second, third].forEach((member) => registrarSocket(member, io, manager));
  const created = await acionar(host, 'salas:criar', { name: 'Duas telas', visibility: 'public' });
  await acionar(second, 'salas:entrar', { roomId: created.room.id });
  await acionar(third, 'salas:entrar', { roomId: created.room.id });
  await acionar(host, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  await acionar(second, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;
  host.handlers.get('disconnect')();

  assert.equal(manager.getRoom(created.room.id).isLive, true);
  assert.equal(manager.getRoom(created.room.id).reservedPresenterSlot, true);
  assert.deepEqual(manager.getRoom(created.room.id).presenters, [{ socketId: second.id, name: 'Bia' }]);
  assert.equal(manager.setLive(created.room.id, third.id, true).ok, false);
  assert.ok(io.enviados.some(({ evento, dados }) => evento === 'sala:transmissao'
    && dados.isLive === true && dados.previousPresenterSocketId === host.id
    && dados.presenters?.[0]?.socketId === second.id));

  const replacement = socketDeTeste('host-new', { id: 1, nome: 'Anfitrião' });
  registrarSocket(replacement, io, manager);
  const joined = await acionar(replacement, 'salas:entrar', { roomId: created.room.id });
  assert.equal(joined.role, 'host');
  assert.deepEqual(joined.presenters, [
    { socketId: replacement.id, name: 'Anfitrião' },
    { socketId: second.id, name: 'Bia' },
  ]);
  assert.equal(joined.room.reservedPresenterSlot, false);
  assert.equal(joined.presenterSocketId, replacement.id);
  assert.equal(timers.timers.size, 0);
  assert.ok(io.enviados.some(({ evento, dados }) => evento === 'sala:transmissao'
    && dados.presenters?.length === 2 && dados.presenterSocketId === replacement.id));
});

test('screen room socket: entrada e spectator-ready avisam os dois presenters', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const first = socketDeTeste('first', { id: 2, nome: 'Ana' });
  const second = socketDeTeste('second', { id: 3, nome: 'Bia' });
  const viewer = socketDeTeste('viewer', null, true);
  [host, first, second, viewer].forEach((member) => registrarSocket(member, io, manager));
  const created = await acionar(host, 'salas:criar', { name: 'Duas telas', visibility: 'public' });
  await acionar(first, 'salas:entrar', { roomId: created.room.id });
  await acionar(second, 'salas:entrar', { roomId: created.room.id });
  await acionar(first, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  await acionar(second, 'salas:ao-vivo', { roomId: created.room.id, isLive: true });
  io.enviados.length = 0;

  const joined = await acionar(viewer, 'salas:entrar', { roomId: created.room.id });
  assert.deepEqual(joined.peerSocketIds, [first.id, second.id]);
  assert.deepEqual(joined.presenters, [
    { socketId: first.id, name: 'Ana' }, { socketId: second.id, name: 'Bia' },
  ]);
  for (const presenter of [first, second]) {
    assert.ok(io.enviados.some(({ destino, evento, dados }) => destino === presenter.id
      && evento === 'sala:espectador-entrou' && dados.socketId === viewer.id));
  }
  io.enviados.length = 0;
  const ready = await acionar(viewer, 'sala:espectador-pronto', { roomId: created.room.id });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.presenters, joined.presenters);
  for (const presenter of [first, second]) {
    assert.ok(io.enviados.some(({ destino, evento, dados }) => destino === presenter.id
      && evento === 'sala:espectador-entrou' && dados.socketId === viewer.id));
  }
});

test('screen room: streamId separates signaling for two presenters', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const first = socketDeTeste('first', { id: 2, nome: 'Ana' });
  const second = socketDeTeste('second', { id: 3, nome: 'Bia' });
  const viewer = socketDeTeste('viewer', null, true);
  const outsider = socketDeTeste('outsider', { id: 4, nome: 'Fora' });
  [host, first, second, viewer, outsider].forEach((member) => registrarSocket(member, io, manager));
  const room = await acionar(host, 'salas:criar', { name: 'Duas telas', visibility: 'public' });
  await acionar(outsider, 'salas:criar', { name: 'Outra', visibility: 'public' });
  for (const member of [first, second, viewer]) await acionar(member, 'salas:entrar', { roomId: room.room.id });
  await acionar(first, 'salas:ao-vivo', { roomId: room.room.id, isLive: true });
  await acionar(second, 'salas:ao-vivo', { roomId: room.room.id, isLive: true });
  io.enviados.length = 0;

  const valid = [
    [first, 'oferta', viewer, 'descricao', first.id],
    [second, 'oferta', viewer, 'descricao', second.id],
    [viewer, 'resposta', first, 'resposta', first.id],
    [viewer, 'resposta', second, 'resposta', second.id],
    [first, 'candidato', viewer, 'candidato', first.id],
    [viewer, 'candidato', second, 'candidato', second.id],
  ];
  for (const [from, type, to, key, streamId] of valid) {
    const result = await acionar(from, `sala:sinal:${type}`, {
      roomId: room.room.id, para: to.id, streamId, [key]: { value: type },
    });
    assert.equal(result.ok, true, `${type} for ${streamId}`);
    assert.ok(io.enviados.some(({ destino, evento, dados }) => destino === to.id
      && evento === `sala:sinal:${type}` && dados.streamId === streamId && dados.de === from.id));
  }

  const legacyOffer = await acionar(first, 'sala:sinal:oferta', {
    roomId: room.room.id, para: viewer.id, descricao: { type: 'offer', sdp: 'legacy-first' },
  });
  const legacyAnswer = await acionar(viewer, 'sala:sinal:resposta', {
    roomId: room.room.id, para: second.id, resposta: { type: 'answer', sdp: 'legacy-second' },
  });
  const legacyCandidate = await acionar(viewer, 'sala:sinal:candidato', {
    roomId: room.room.id, para: second.id, candidato: { candidate: 'legacy-second-ice' },
  });
  assert.equal(legacyOffer.streamId, first.id);
  assert.equal(legacyAnswer.streamId, second.id);
  assert.equal(legacyCandidate.streamId, second.id);

  const rejected = [
    [first, 'oferta', viewer, 'descricao', second.id],
    [viewer, 'resposta', first, 'resposta', second.id],
    [viewer, 'candidato', first, 'candidato', second.id],
    [first, 'oferta', outsider, 'descricao', first.id],
    [outsider, 'resposta', first, 'resposta', first.id],
    [first, 'oferta', viewer, 'descricao', 'missing'],
  ];
  for (const [from, type, to, key, streamId] of rejected) {
    io.enviados.length = 0;
    const result = await acionar(from, `sala:sinal:${type}`, {
      roomId: room.room.id, para: to.id, ...(streamId === undefined ? {} : { streamId }),
      [key]: { value: type },
    });
    assert.equal(result.ok, false, `${type} from ${from.id} to ${to.id} for ${streamId}`);
    assert.equal(io.enviados.some(({ evento }) => evento.startsWith('sala:sinal:')), false);
  }
  assert.equal(manager.canSignal({ roomId: room.room.id, fromSocketId: first.id,
    toSocketId: viewer.id, signalType: 'offer', streamId: second.id }), false);
});

test('screen room socket: saída definitiva do anfitrião após o prazo encerra sala e remove espectadores', async () => {
  const timers = timersDeTeste();
  const manager = managerDeTeste({
    hostReconnectGraceMs: 15_000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Sessão', visibility: 'public' });
  registrarSocket(viewer, io, manager);
  await acionar(viewer, 'salas:entrar', { roomId: created.room.id });

  host.handlers.get('disconnect')();
  assert.ok(manager.getRoom(created.room.id), 'room remains available during reconnect grace');
  assert.equal(io.enviados.some((item) => item.evento === 'sala:encerrada'), false);

  timers.executar();

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

test('YouTube por sala: anfitrião altera a fonte e a troca reinicia playback com revisão crescente', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const member = socketDeTeste('member-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(member, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Vídeo', visibility: 'public' });
  await acionar(member, 'salas:entrar', { roomId: created.room.id });
  const roomChannel = `sala-${created.room.id}`;
  io.enviados.length = 0;

  const sourceSet = await acionar(host, 'sala:youtube:fonte', {
    roomId: created.room.id, videoId: 'dQw4w9WgXcQ',
  });
  assert.equal(sourceSet.ok, true);
  assert.deepEqual(sourceSet.source, { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(sourceSet.playback, {
    action: 'play', currentTime: 0, updatedAt: sourceSet.playback.updatedAt, revision: 1,
  });
  assert.ok(Number.isFinite(Date.parse(sourceSet.playback.updatedAt)));
  const sourceBroadcast = io.enviados.find((item) => item.destino === roomChannel
    && item.evento === 'sala:youtube:estado');
  assert.deepEqual(sourceBroadcast.dados, {
    salaId: created.room.id,
    source: sourceSet.source,
    playback: sourceSet.playback,
  });

  const seek = await acionar(member, 'sala:youtube:reproducao', {
    roomId: created.room.id, action: 'seek', currentTime: 95.5,
  });
  assert.equal(seek.ok, true);
  assert.deepEqual(seek.playback, {
    action: 'play', currentTime: 95.5, updatedAt: seek.playback.updatedAt, revision: 2,
  });
  const playbackBroadcast = io.enviados.find((item) => item.destino === roomChannel
    && item.evento === 'sala:youtube:reproducao');
  assert.deepEqual(playbackBroadcast.dados, {
    salaId: created.room.id,
    playback: seek.playback,
  });

  const sourceReplaced = await acionar(host, 'sala:youtube:fonte', {
    roomId: created.room.id, videoId: 'M7lc1UVf-VE',
  });
  assert.equal(sourceReplaced.ok, true);
  assert.deepEqual(sourceReplaced.source, { videoId: 'M7lc1UVf-VE' });
  assert.equal(sourceReplaced.playback.action, 'play');
  assert.equal(sourceReplaced.playback.currentTime, 0);
  assert.equal(sourceReplaced.playback.revision, 3);

  const sourceCleared = await acionar(host, 'sala:youtube:fonte', {
    roomId: created.room.id, videoId: null,
  });
  assert.equal(sourceCleared.ok, true);
  assert.equal(sourceCleared.source, null);
  assert.equal(sourceCleared.playback.revision, 4);
  assert.ok(io.enviados.some((item) => item.destino === roomChannel
    && item.evento === 'sala:youtube:estado'
    && item.dados.source === null
    && item.dados.playback.revision === 4));
});

test('YouTube por sala: apenas anfitrião define fonte e videoId aceita exatamente onze caracteres válidos', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const member = socketDeTeste('member-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(member, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Vídeo', visibility: 'private' });
  await acionar(member, 'salas:entrar', { accessCode: created.accessCode });
  io.enviados.length = 0;

  const denied = await acionar(member, 'sala:youtube:fonte', {
    roomId: created.room.id, videoId: 'dQw4w9WgXcQ',
  });
  assert.equal(denied.ok, false);
  assert.equal(io.enviados.some((item) => item.evento === 'sala:youtube:estado'), false);

  for (const videoId of ['short', 'dQw4w9WgXcQx', 'dQw4w9WgXc!', '', 42]) {
    const invalid = await acionar(host, 'sala:youtube:fonte', { roomId: created.room.id, videoId });
    assert.equal(invalid.ok, false, `videoId inválido aceito: ${String(videoId)}`);
  }
  const valid = await acionar(host, 'sala:youtube:fonte', {
    roomId: created.room.id, videoId: 'aB_2-345678',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.source.videoId, 'aB_2-345678');
});

test('YouTube e compartilhamento de tela não ocupam o palco ao mesmo tempo', () => {
  const manager = managerDeTeste();
  const created = criarSala(manager);
  manager.joinRoom({ roomId: created.room.id, socketId: 'second' });

  assert.equal(manager.setYoutubeSource(created.room.id, 'host-socket', 'dQw4w9WgXcQ').ok, true);
  assert.equal(manager.setLive(created.room.id, 'host-socket', true).ok, false);
  assert.equal(manager.setYoutubeSource(created.room.id, 'host-socket', null).ok, true);
  assert.equal(manager.setLive(created.room.id, 'host-socket', true).ok, true);
  assert.equal(manager.setLive(created.room.id, 'second', true).ok, true);
  assert.equal(manager.setLive(created.room.id, 'host-socket', false).room.isLive, true);
  assert.equal(manager.setYoutubeSource(created.room.id, 'host-socket', 'dQw4w9WgXcQ').ok, false);
  assert.equal(manager.setLive(created.room.id, 'second', false).room.isLive, false);
  assert.equal(manager.setYoutubeSource(created.room.id, 'host-socket', 'dQw4w9WgXcQ').ok, true);
});

test('YouTube por sala: membros controlam playback com ações e tempos limitados', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  const member = socketDeTeste('member-socket', null, true);
  registrarSocket(host, io, manager);
  registrarSocket(member, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Vídeo', visibility: 'public' });
  await acionar(member, 'salas:entrar', { roomId: created.room.id });
  await acionar(host, 'sala:youtube:fonte', { roomId: created.room.id, videoId: 'dQw4w9WgXcQ' });

  const play = await acionar(member, 'sala:youtube:reproducao', { roomId: created.room.id, action: 'play' });
  assert.equal(play.ok, true);
  assert.equal(play.playback.action, 'play');
  assert.equal(play.playback.currentTime, 0);
  const pause = await acionar(host, 'sala:youtube:reproducao', {
    roomId: created.room.id, action: 'pause', currentTime: 12,
  });
  assert.equal(pause.ok, true);
  assert.equal(pause.playback.currentTime, 12);

  for (const invalid of [
    { action: 'stop', currentTime: 0 },
    { action: 'seek', currentTime: -0.01 },
    { action: 'seek', currentTime: 86400.01 },
    { action: 'seek', currentTime: Number.NaN },
    { action: 'seek', currentTime: Number.POSITIVE_INFINITY },
    { action: 'play', currentTime: Number.NaN },
  ]) {
    const result = await acionar(member, 'sala:youtube:reproducao', { roomId: created.room.id, ...invalid });
    assert.equal(result.ok, false, `reprodução inválida aceita: ${JSON.stringify(invalid)}`);
  }

  const maximumSeek = await acionar(member, 'sala:youtube:reproducao', {
    roomId: created.room.id, action: 'seek', currentTime: 86400,
  });
  assert.equal(maximumSeek.ok, true);
  assert.equal(maximumSeek.playback.currentTime, 86400);
  assert.equal(maximumSeek.playback.action, 'pause', 'seeking while paused preserves the paused state');
  assert.equal(maximumSeek.playback.revision, 4);
});

test('YouTube por sala: rejeita sockets fora do canal e não mistura estado entre salas privadas', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const hostA = socketDeTeste('host-a', { id: 1, nome: 'A' });
  const hostB = socketDeTeste('host-b', { id: 2, nome: 'B' });
  const outsider = socketDeTeste('outsider', null, true);
  [hostA, hostB, outsider].forEach((socket) => registrarSocket(socket, io, manager));
  const roomA = await acionar(hostA, 'salas:criar', { name: 'Privada A', visibility: 'private' });
  const roomB = await acionar(hostB, 'salas:criar', { name: 'Privada B', visibility: 'private' });
  await acionar(outsider, 'salas:entrar', { accessCode: roomB.accessCode });
  io.enviados.length = 0;

  const crossRoom = await acionar(outsider, 'sala:youtube:fonte', {
    roomId: roomA.room.id, videoId: 'dQw4w9WgXcQ',
  });
  assert.equal(crossRoom.ok, false);
  assert.equal(io.enviados.some((item) => item.destino === `sala-${roomA.room.id}`), false);
  assert.equal(io.enviados.some((item) => item.destino === `sala-${roomB.room.id}`), false);

  const orphanedMembership = socketDeTeste('orphaned', null, true);
  registrarSocket(orphanedMembership, io, manager);
  await acionar(orphanedMembership, 'salas:entrar', { accessCode: roomA.accessCode });
  orphanedMembership.recebidos.length = 0;
  io.enviados.length = 0;
  orphanedMembership.salasSocket.delete(`sala-${roomA.room.id}`);
  const staleSocket = await acionar(orphanedMembership, 'sala:youtube:reproducao', {
    roomId: roomA.room.id, action: 'play',
  });
  assert.equal(staleSocket.ok, false);
  assert.equal(orphanedMembership.recebidos.some((item) => item.evento === 'sala:youtube:estado'), false);
  assert.equal(io.enviados.some((item) => item.evento === 'sala:youtube:reproducao'), false);
});

test('YouTube por sala: entrada recebe a fonte e playback atuais somente após entrar no canal', async () => {
  const manager = managerDeTeste();
  const io = ioDeTeste();
  const host = socketDeTeste('host-socket', { id: 1, nome: 'Anfitrião' });
  registrarSocket(host, io, manager);
  const created = await acionar(host, 'salas:criar', { name: 'Privada', visibility: 'private' });
  await acionar(host, 'sala:youtube:fonte', { roomId: created.room.id, videoId: 'dQw4w9WgXcQ' });
  await acionar(host, 'sala:youtube:reproducao', {
    roomId: created.room.id, action: 'seek', currentTime: 321,
  });

  const viewer = socketDeTeste('viewer-socket', null, true);
  registrarSocket(viewer, io, manager);
  const joined = await acionar(viewer, 'salas:entrar', { accessCode: created.accessCode });

  assert.equal(joined.ok, true);
  assert.equal(joined.youtubeSource.videoId, 'dQw4w9WgXcQ');
  assert.deepEqual(joined.youtubePlayback, {
    action: 'play', currentTime: 321,
    updatedAt: joined.youtubePlayback.updatedAt, revision: 2,
  });
  assert.ok(viewer.recebidos.some((item) => item.evento === 'sala:youtube:estado'
    && item.dados.salaId === created.room.id
    && item.dados.source.videoId === 'dQw4w9WgXcQ'
    && item.dados.playback.revision === 2));

  const unjoined = socketDeTeste('unjoined', null, true);
  registrarSocket(unjoined, io, manager);
  assert.equal(unjoined.recebidos.some((item) => item.evento === 'sala:youtube:estado'), false);
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
