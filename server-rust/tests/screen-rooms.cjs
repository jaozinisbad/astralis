// Reusable Socket.IO contract checks for the Node and Rust screen room servers.
const assert = require('node:assert/strict');
const { io } = require('../../client/node_modules/socket.io-client');

function onEvent(socket, name, test = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      socket.off(name, listener);
    }
    function listener(value) {
      if (!test(value)) return;
      cleanup();
      resolve(value);
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing ${name} on ${socket.id}`));
    }, timeout);
    socket.on(name, listener);
  });
}

async function verifyScreenRooms(baseUrl, auths, { expireHost = false } = {}) {
  const sockets = [];
  async function connect(auth) {
    const socket = io(baseUrl, {
      auth: typeof auth === 'string' ? { token: auth } : auth,
      forceNew: true, reconnection: false, autoConnect: false,
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.once('connect', resolve);
      socket.connect();
    });
    return socket;
  }
  const send = (socket, event, data = {}) => socket.timeout(4000).emitWithAck(event, data);
  const entered = (viewer, stream, host, roomId) =>
    onEvent(stream, 'sala:espectador-entrou', e =>
      e.salaId === roomId && e.socketId === viewer.id && (!host || e.streamId === host.id));
  try {
    const [host, viewer, observer] = await Promise.all(auths.map(connect));
    const publicRoom = await send(observer, 'salas:criar', { name: ' Teste público ', visibility: 'public' });
    assert.equal(publicRoom.room.name, 'Teste público');
    assert.equal('accessCode' in publicRoom, false);
    const publicId = publicRoom.room.id;
    const roomList = async () => (await send(viewer, 'salas:listar')).rooms;
    assert.equal((await roomList()).some(room => room.id === publicId), false);
    assert.equal((await send(observer, 'salas:ao-vivo', { roomId: publicId, isLive: true })).ok, true);
    assert.equal((await roomList()).some(room => room.id === publicId), true);
    assert.equal((await send(observer, 'salas:encerrar', { roomId: publicId })).ok, true);
    assert.equal((await roomList()).some(room => room.id === publicId), false);

    const created = await send(host, 'salas:criar', { name: 'Teste privado', visibility: 'private' });
    assert.equal(created.ok, true);
    assert.match(created.accessCode, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal('accessCode' in created.room, false);
    const roomId = created.room.id;
    assert.equal((await send(viewer, 'sala:ice-config', { roomId })).ok, false);
    assert.equal((await send(viewer, 'salas:entrar', { roomId, accessCode: '❌' })).ok, false);
    const viewerEntered = entered(viewer, host, null, roomId);
    const joined = await send(viewer, 'salas:entrar', { accessCode: ` ${created.accessCode.toLowerCase()} ` });
    assert.equal(joined.role, 'viewer');
    assert.deepEqual(joined.peerSocketIds, [host.id]);
    assert.equal('accessCode' in joined, false);
    await viewerEntered;
    const repeat = await send(viewer, 'salas:entrar', { roomId });
    assert.equal(repeat.room.viewerCount, 1);
    assert.equal('hostReconnected' in repeat, false);
    assert.ok((await send(viewer, 'sala:ice-config', { roomId })).iceServers.length > 0);

    const first = await send(host, 'salas:ao-vivo', { roomId, isLive: true });
    assert.deepEqual(first.presenters.map(p => p.socketId), [host.id]);
    const second = await send(viewer, 'salas:ao-vivo', { roomId, isLive: true });
    assert.deepEqual(second.presenters.map(p => p.socketId), [host.id, viewer.id]);
    assert.equal(second.presenterSocketId, host.id);
    assert.equal((await roomList()).some(room => room.id === roomId), false);
    assert.equal((await send(host, 'sala:youtube:fonte', { roomId, videoId: 'dQw4w9WgXcQ' })).ok, false);

    const bothEntered = [entered(observer, host, null, roomId), entered(observer, viewer, null, roomId)];
    const observerJoin = await send(observer, 'salas:entrar', { roomId, accessCode: created.accessCode });
    assert.deepEqual(observerJoin.peerSocketIds, [host.id, viewer.id]);
    await Promise.all(bothEntered);
    assert.equal((await send(observer, 'salas:ao-vivo', { roomId, isLive: true })).ok, false);
    assert.equal((await send(observer, 'salas:encerrar', { roomId })).ok, false);
    const recovery = entered(observer, viewer, viewer, roomId);
    assert.equal((await send(observer, 'sala:espectador-pronto', { roomId, streamId: viewer.id, restart: true })).ok, true);
    assert.equal((await recovery).restart, true);
    assert.equal((await send(observer, 'sala:espectador-pronto', { roomId, restart: true })).ok, false);

    const offer = onEvent(observer, 'sala:sinal:oferta');
    const description = { type: 'offer', sdp: 'test-offer' };
    assert.deepEqual(await send(viewer, 'sala:sinal:oferta', { roomId, para: observer.id, dados: description }),
      { ok: true, streamId: viewer.id });
    assert.deepEqual(await offer, { roomId, de: viewer.id, streamId: viewer.id, descricao: description });
    const answer = onEvent(viewer, 'sala:sinal:resposta');
    const response = { type: 'answer', sdp: 'test-answer' };
    assert.equal((await send(observer, 'sala:sinal:resposta', { roomId, para: viewer.id, streamId: viewer.id, resposta: response })).ok, true);
    assert.deepEqual(await answer, { roomId, de: observer.id, streamId: viewer.id, resposta: response });
    const iceCandidate = onEvent(viewer, 'sala:sinal:candidato');
    const candidate = { candidate: 'test-candidate', sdpMid: '0' };
    assert.equal((await send(observer, 'sala:sinal:candidato', { roomId, para: viewer.id, streamId: viewer.id, candidato: candidate })).ok, true);
    assert.deepEqual(await iceCandidate, { roomId, de: observer.id, streamId: viewer.id, candidato: candidate });
    assert.equal((await send(observer, 'sala:sinal:oferta', { roomId, para: viewer.id, streamId: viewer.id, descricao: description })).ok, false);

    const ownerSocketId = host.id;
    const reserved = onEvent(observer, 'sala:estado', e => e.sala.id === roomId && e.sala.reservedPresenterSlot);
    host.disconnect();
    assert.deepEqual((await reserved).sala.presenters.map(p => p.socketId), [viewer.id]);
    assert.equal((await send(observer, 'salas:ao-vivo', { roomId, isLive: true })).ok, false);
    assert.equal((await send(viewer, 'sala:sinal:oferta', { roomId, para: ownerSocketId, descricao: description })).ok, false);
    const returningHost = await connect(auths[0]);
    const entry = await send(returningHost, 'salas:entrar', { roomId });
    assert.equal(entry.hostReconnected, true);
    assert.equal(entry.accessCode, created.accessCode);
    assert.deepEqual(entry.presenters.map(p => p.socketId), [returningHost.id, viewer.id]);

    assert.equal((await send(returningHost, 'salas:ao-vivo', { roomId, isLive: false })).room.isLive, true);
    assert.equal((await send(viewer, 'salas:ao-vivo', { roomId, isLive: false })).room.isLive, false);
    assert.equal((await send(viewer, 'sala:youtube:fonte', { roomId, videoId: 'dQw4w9WgXcQ' })).ok, false);
    const source = await send(returningHost, 'sala:youtube:fonte', { roomId, videoId: 'dQw4w9WgXcQ' });
    assert.equal(source.playback.action, 'play');
    assert.equal((await send(viewer, 'salas:ao-vivo', { roomId, isLive: true })).ok, false);
    const paused = await send(viewer, 'sala:youtube:reproducao', { roomId, action: 'pause', currentTime: 5 });
    const sought = await send(observer, 'sala:youtube:reproducao', { roomId, action: 'seek', currentTime: 9.5 });
    assert.equal(sought.playback.revision, paused.playback.revision + 1);
    assert.equal(sought.playback.action, 'pause');
    assert.equal(sought.playback.currentTime, 9.5);
    assert.equal((await send(observer, 'sala:youtube:reproducao', { roomId, action: 'seek', currentTime: -1 })).ok, false);
    assert.equal((await send(observer, 'salas:sair')).room.viewerCount, 1);
    assert.equal((await send(observer, 'sala:ice-config', { roomId })).ok, false);
    const rejoined = await send(observer, 'salas:entrar', { roomId, accessCode: created.accessCode });
    assert.deepEqual(rejoined.youtubeSource, source.source);
    assert.deepEqual(rejoined.youtubePlayback, sought.playback);

    const closed = onEvent(viewer, 'sala:encerrada', e => e.salaId === roomId, expireHost ? 35000 : 4000);
    if (expireHost) returningHost.disconnect();
    else assert.equal((await send(returningHost, 'salas:encerrar', { roomId })).ok, true);
    await closed;
    assert.equal((await send(viewer, 'sala:ice-config', { roomId })).ok, false);
    assert.equal((await send(viewer, 'salas:entrar', { accessCode: created.accessCode })).ok, false);
    assert.equal((await send(viewer, 'salas:sair')).ok, false);
  } finally {
    for (const socket of sockets) {
      if (socket.connected) await send(socket, 'salas:sair').catch(() => {});
      socket.disconnect();
    }
  }
}

module.exports = { verifyScreenRooms };
