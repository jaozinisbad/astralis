const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDirectCallManager } = require('../directCalls');

function fixture(options = {}) {
  const sockets = new Map();
  const timers = new Map();
  const events = [];
  let id = 0;
  const io = {
    sockets: { sockets },
    to: (socketId) => ({ emit: (event, data) => events.push({ socketId, event, data }) }),
  };
  const manager = createDirectCallManager({
    io,
    areFriends: async (a, b) => [1, 2].includes(a) && [1, 2].includes(b) && a !== b,
    getUser: async (userId) => ({ id: userId, nome: `Pessoa ${userId}` }),
    makeId: () => `call-${++id}`,
    setTimeoutImpl: (callback) => { const timer = Symbol(); timers.set(timer, callback); return timer; },
    clearTimeoutImpl: (timer) => timers.delete(timer),
    ...options,
  });
  function socket(socketId, userId) {
    const listeners = new Map();
    const result = {
      id: socketId, usuario: { id: userId, nome: `Pessoa ${userId}` }, connected: true,
      emit: (event, data) => events.push({ socketId, event, data }),
      on: (event, handler) => listeners.set(event, handler),
      send: (event, data) => new Promise((resolve) => listeners.get(event)(data, resolve)),
    };
    sockets.set(socketId, result);
    manager.register(result);
    return result;
  }
  const caller = socket('caller', 1);
  const callee = socket('callee', 2);
  const outsider = socket('outsider', 3);
  return { manager, caller, callee, outsider, socket, timers, events, sockets };
}

async function begin(f) {
  const result = await f.caller.send('chamada:iniciar', { paraUsuarioId: 2 });
  assert.equal(result.ok, true);
  return result.call;
}

async function active(f) {
  const call = await begin(f);
  const result = await f.callee.send('chamada:aceitar', { callId: call.id });
  assert.equal(result.ok, true);
  return result.call;
}

test('cancelar ou recusar cruzando o aceite também encerra a chamada ativa, sem liberar outra aba', async () => {
  for (const [side, event] of [['caller', 'chamada:cancelar'], ['callee', 'chamada:recusar']]) {
    const f = fixture();
    const call = await active(f);
    const otherTab = f.socket('other-tab', f[side].usuario.id);
    assert.equal((await otherTab.send(event, { callId: call.id })).ok, false);
    assert.equal((await f[side].send(event, { callId: call.id })).ok, true);
    assert.equal(f.manager.isUserBusy(1), false);
    assert.equal(f.manager.isUserBusy(2), false);
    assert.equal(f.events.at(-1).data.reason, 'ended');
  }
});

test('convite exige amizade aceita, conta válida e destinatário diferente', async () => {
  const f = fixture();
  assert.equal((await f.caller.send('chamada:iniciar', { paraUsuarioId: 3 })).code, 'not-friends');
  assert.equal((await f.caller.send('chamada:iniciar', { paraUsuarioId: 1 })).code, 'invalid');
  assert.equal((await f.caller.send('chamada:iniciar', {})).code, 'invalid');
  f.caller.espectadorAnonimo = true;
  assert.equal((await f.caller.send('chamada:iniciar', { paraUsuarioId: 2 })).code, 'forbidden');
  assert.equal(f.events.some((event) => event.event === 'chamada:recebida'), false);
});

test('convite offline falha sem deixar usuários ocupados', async () => {
  const f = fixture();
  f.callee.connected = false;
  assert.equal((await f.caller.send('chamada:iniciar', { paraUsuarioId: 2 })).code, 'offline');
  assert.equal(f.manager.isUserBusy(1), false);
  assert.equal(f.manager.isUserBusy(2), false);
});

test('aceite autoriza só a conta convidada e nenhum peer recebe mídia antes do aceite', async () => {
  const f = fixture();
  const call = await begin(f);
  assert.equal((await f.outsider.send('chamada:aceitar', { callId: call.id })).code, 'forbidden');
  assert.equal((await f.caller.send('chamada:aceitar', { callId: call.id })).code, 'forbidden');
  assert.equal(f.manager.joinVoice(f.caller, call.canalId).ok, false);
  assert.equal(f.manager.joinVoice(f.callee, call.canalId).ok, false);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), false);
  assert.equal(f.events.some((event) => event.event === 'peers-existentes' || event.event === 'novo-peer'), false);
});

test('fluxo aceito usa o protocolo de voz e encerra as duas pontas e a transmissão', async () => {
  const f = fixture();
  const call = await active(f);
  assert.equal(call.status, 'active');
  assert.equal(f.timers.size, 0);
  assert.equal(f.manager.joinVoice(f.caller, call.canalId).ok, true);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), false);
  assert.equal(f.manager.joinVoice(f.callee, call.canalId).ok, true);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), true);
  assert.equal(f.manager.canSignal(f.callee, f.caller.id), true);
  assert.equal(f.manager.canSignal(f.caller, f.caller.id), false);
  const peers = f.events.find((event) => event.socketId === 'callee' && event.event === 'peers-existentes');
  assert.equal(peers.data.peers[0].socketId, 'caller');
  assert.ok(f.events.some((event) => event.socketId === 'caller' && event.event === 'novo-peer'));
  f.manager.screenStopped(f.caller);
  assert.ok(f.events.some((event) => event.socketId === 'callee' && event.event === 'tela-parada'));

  assert.equal((await f.caller.send('chamada:encerrar', { callId: call.id })).ok, true);
  assert.equal(f.caller.canalVozAtual, null);
  assert.equal(f.callee.canalVozAtual, null);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), false);
  assert.equal(f.manager.isUserBusy(1), false);
  assert.equal(f.manager.isUserBusy(2), false);
  assert.equal(f.events.filter((event) => event.event === 'chamada:encerrada' && event.data.reason === 'ended').length, 2);
});

test('nem terceiro nem outra aba da mesma conta podem entrar, sinalizar ou desligar a chamada', async () => {
  const f = fixture();
  const extra = f.socket('caller-extra', 1);
  const call = await active(f);
  f.manager.joinVoice(f.caller, call.canalId);
  f.manager.joinVoice(f.callee, call.canalId);
  for (const rejected of [f.outsider, extra]) {
    assert.equal(f.manager.joinVoice(rejected, call.canalId).code, 'forbidden');
    rejected.canalVozAtual = call.canalId;
    assert.equal(f.manager.canSignal(rejected, f.callee.id), false);
    assert.equal(f.manager.canSignal(f.callee, rejected.id), false);
    assert.equal((await rejected.send('chamada:encerrar', { callId: call.id })).code, 'forbidden');
  }
});

test('ocupado vale para os dois usuários e todas as abas, inclusive voz de servidor', async () => {
  const f = fixture();
  await begin(f);
  const extra = f.socket('caller-extra', 1);
  assert.equal((await extra.send('chamada:iniciar', { paraUsuarioId: 2 })).code, 'busy');
  assert.equal((await f.callee.send('chamada:iniciar', { paraUsuarioId: 1 })).code, 'busy');
  const externallyBusy = fixture({ isExternallyBusy: (userId) => userId === 2 });
  assert.equal((await externallyBusy.caller.send('chamada:iniciar', { paraUsuarioId: 2 })).code, 'busy');
});

test('convites concorrentes após consultas assíncronas reservam um único contexto', async () => {
  const f = fixture();
  const extra = f.socket('caller-extra', 1);
  const results = await Promise.all([
    f.caller.send('chamada:iniciar', { paraUsuarioId: 2 }),
    extra.send('chamada:iniciar', { paraUsuarioId: 2 }),
    f.callee.send('chamada:iniciar', { paraUsuarioId: 1 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'busy').length, 2);
});

test('duas abas atendendo ao mesmo tempo escolhem só uma e limpam o toque da outra', async () => {
  const f = fixture();
  const second = f.socket('callee-extra', 2);
  const call = await begin(f);
  assert.equal(f.events.filter((event) => event.event === 'chamada:recebida').length, 2);
  const results = await Promise.all([
    f.callee.send('chamada:aceitar', { callId: call.id }),
    second.send('chamada:aceitar', { callId: call.id }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'busy').length, 1);
  assert.ok(f.events.some((event) => event.socketId === second.id && event.data?.reason === 'answered-elsewhere'));
  assert.equal(f.manager.joinVoice(second, call.canalId).ok, false);
});

test('timeout, recusa e cancelamento liberam a reserva e impedem aceite tardio', async () => {
  for (const action of ['timeout', 'declined', 'cancelled']) {
    const f = fixture();
    const call = await begin(f);
    if (action === 'timeout') [...f.timers.values()].forEach((callback) => callback());
    if (action === 'declined') assert.equal((await f.callee.send('chamada:recusar', { callId: call.id })).ok, true);
    if (action === 'cancelled') assert.equal((await f.caller.send('chamada:cancelar', { callId: call.id })).ok, true);
    assert.equal(f.manager.isUserBusy(1), false);
    assert.equal(f.manager.isUserBusy(2), false);
    assert.equal((await f.callee.send('chamada:aceitar', { callId: call.id })).code, 'not-found');
    assert.equal(f.events.filter((event) => event.event === 'chamada:encerrada' && event.data.reason === action).length, 2);
  }
});

test('cancelar e recusar exigem o lado certo da ligação e ignoram terceiros', async () => {
  const f = fixture();
  const call = await begin(f);
  assert.equal((await f.callee.send('chamada:cancelar', { callId: call.id })).code, 'forbidden');
  assert.equal((await f.caller.send('chamada:recusar', { callId: call.id })).code, 'forbidden');
  assert.equal((await f.outsider.send('chamada:recusar', { callId: call.id })).code, 'forbidden');
  assert.equal(f.manager.isUserBusy(1), true);
});

test('fechar uma aba que toca preserva convite nas demais e fechar a última encerra', async () => {
  const f = fixture();
  const second = f.socket('callee-extra', 2);
  await begin(f);
  f.manager.disconnect(f.callee);
  assert.equal(f.manager.isUserBusy(1), true);
  f.manager.disconnect(second);
  assert.equal(f.manager.isUserBusy(1), false);
  assert.ok(f.events.some((event) => event.event === 'chamada:encerrada' && event.data.reason === 'disconnected'));
});

test('desconectar uma ponta ativa encerra áudio sem encerrar por outra aba', async () => {
  const f = fixture();
  const second = f.socket('caller-extra', 1);
  const call = await active(f);
  f.manager.joinVoice(f.caller, call.canalId);
  f.manager.joinVoice(f.callee, call.canalId);
  f.manager.disconnect(second);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), true);
  f.manager.disconnect(f.callee);
  assert.equal(f.manager.isUserBusy(1), false);
  assert.equal(f.caller.canalVozAtual, null);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), false);
  assert.equal(f.manager.joinVoice(f.caller, call.canalId).ok, false);
});

test('aba nova recebe convite pendente sem herdar chamada ativa', async () => {
  const f = fixture();
  const call = await begin(f);
  const second = f.socket('callee-extra', 2);
  assert.ok(f.events.some((event) => event.socketId === second.id && event.event === 'chamada:recebida'));
  await second.send('chamada:aceitar', { callId: call.id });
  const third = f.socket('callee-third', 2);
  assert.equal(f.events.some((event) => event.socketId === third.id), false);
  assert.equal(f.manager.joinVoice(third, call.canalId).ok, false);
});

test('amizade removida impede aceite e encerra uma chamada ativa imediatamente', async () => {
  let friends = true;
  const f = fixture({ areFriends: async () => friends });
  const call = await begin(f);
  friends = false;
  assert.equal((await f.callee.send('chamada:aceitar', { callId: call.id })).code, 'not-friends');
  assert.equal(f.manager.isUserBusy(1), false);
  friends = true;
  const next = await active(f);
  f.manager.joinVoice(f.caller, next.canalId);
  f.manager.joinVoice(f.callee, next.canalId);
  friends = false;
  await f.manager.revalidateUsers([1, 2]);
  assert.equal(f.manager.isUserBusy(2), false);
  assert.equal(f.manager.canSignal(f.caller, f.callee.id), false);
});

test('desconexão durante consultas não cria convite órfão', async () => {
  let release;
  const f = fixture({ areFriends: () => new Promise((resolve) => { release = resolve; }) });
  const pending = f.caller.send('chamada:iniciar', { paraUsuarioId: 2 });
  f.manager.disconnect(f.caller);
  release(true);
  assert.equal((await pending).code, 'disconnected');
  assert.equal(f.manager.isUserBusy(2), false);
});

test('cancelar durante checagem de aceite impede uma chamada ressuscitada', async () => {
  let release;
  let pendingAccept = false;
  const f = fixture({ areFriends: () => pendingAccept ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(true) });
  const call = await begin(f);
  pendingAccept = true;
  const pending = f.callee.send('chamada:aceitar', { callId: call.id });
  await f.caller.send('chamada:cancelar', { callId: call.id });
  release(true);
  assert.equal((await pending).code, 'not-found');
  assert.equal(f.events.some((event) => event.event === 'chamada:estado' && event.data.call.status === 'active'), false);
});

test('sair-canal-voz encerra a chamada e não deixa convites presos', async () => {
  const f = fixture();
  const call = await active(f);
  f.manager.joinVoice(f.caller, call.canalId);
  assert.equal(f.manager.leaveVoice(f.caller), true);
  assert.equal(f.manager.isUserBusy(1), false);
  assert.equal(f.manager.isUserBusy(2), false);
});
