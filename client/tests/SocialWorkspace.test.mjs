import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const original = new Map();
let vite, ChatArea, DirectMessageScreen, FriendsScreen, root;
let socket, preferences, responses, calls;
const message = (overrides = {}) => ({ id: 1, conteudo: 'Olá turma', autor: 'Ana', usuario_id: 2, remetente_id: 2, criado_em: '2026-10-18T14:00:00Z', ...overrides });

before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ default: ChatArea } = await vite.ssrLoadModule('/src/components/ChatArea.jsx'));
  ({ default: DirectMessageScreen } = await vite.ssrLoadModule('/src/components/DirectMessageScreen.jsx'));
  ({ default: FriendsScreen } = await vite.ssrLoadModule('/src/components/FriendsScreen.jsx'));
});
after(async () => { await vite?.close(); });
beforeEach(() => {
  for (const key of ['window', 'document', 'localStorage', 'fetch', 'Notification', 'AudioContext', 'FileReader']) original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  preferences = {};
  globalThis.localStorage = { getItem: () => JSON.stringify(preferences), setItem() {} };
  globalThis.window = new EventTarget();
  globalThis.document = { hidden: false, documentElement: { dataset: {}, style: { setProperty() {} } } };
  responses = []; calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    const next = responses.shift() || { ok: true, status: 200, data: [] };
    if (next.promise) return next.promise;
    return { ok: next.ok, status: next.status, json: async () => next.data };
  };
  const handlers = new Map();
  socket = {
    connected: true, sent: [],
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    off(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, data) { this.sent.push([name, data]); },
    receive(name, data) { handlers.get(name)?.forEach((handler) => handler(data)); },
  };
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = null;
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  original.clear();
});
async function mount(Component, props) {
  await act(async () => { root = TestRenderer.create(React.createElement(Component, props)); await Promise.resolve(); });
}
function text() { return root.root.findAll((node) => typeof node.type === 'string').flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' '); }
const channelProps = (overrides = {}) => ({ canal: { id: 3, nome: 'geral', tipo: 'texto' }, statusConexao: 'conectado ao servidor', socket, token: 'token', meuUsuarioId: 1, nomeUsuario: 'João', ...overrides });
const dmProps = (overrides = {}) => ({ amigo: { id: 2, nome: 'Ana', online: true }, socket, token: 'token', meuId: 1, ...overrides });
const button = (name) => root.root.findAllByType('button').find((node) => node.props['aria-label'] === name || node.children.includes(name));
const input = () => root.root.findByType('textarea');

test('amigos filtra online/todos e busca; abrir conversa usa a pessoa real', async () => {
  const opened = [];
  const friends = [{ id: 2, nome: 'Ana', online: true }, { id: 3, nome: 'Bruno', online: false }];
  await mount(FriendsScreen, { amigos: friends, onAbrirDM: (friend) => opened.push(friend.id) });
  assert.ok(button('Conversar com Ana')); assert.equal(button('Conversar com Bruno'), undefined);
  await act(async () => button('Todos').props.onClick());
  assert.ok(button('Conversar com Bruno'));
  await act(async () => root.root.findByType('input').props.onChange({ target: { value: 'brU' } }));
  assert.equal(button('Conversar com Ana'), undefined);
  await act(async () => button('Conversar com Bruno').props.onClick());
  assert.deepEqual(opened, [3]);
});

test('adicionar amigo explica contrato de servidor e encaminha ação sem criar dados falsos', async () => {
  let opened = 0;
  await mount(FriendsScreen, { amigos: [], onAdicionarAmigos: () => opened++ });
  await act(async () => button('Adicionar amigo').props.onClick());
  assert.match(text(), /compartilham um servidor/);
  await act(async () => button('Criar ou entrar em servidor').props.onClick());
  assert.equal(opened, 1);
});

test('falha no histórico permanece visível e pode ser tentada novamente', async () => {
  responses.push({ ok: false, status: 500, data: { erro: 'Histórico indisponível' } });
  await mount(ChatArea, channelProps());
  assert.match(text(), /Histórico indisponível/);
  responses.push({ ok: true, status: 200, data: [message()] });
  await act(async () => { button('Tentar novamente').props.onClick(); await Promise.resolve(); });
  assert.match(text(), /Olá turma/);
  assert.equal(calls.length, 2);
});

test('canal preserva rascunho até eco; Shift Enter não envia; desconexão mantém rascunho', async () => {
  await mount(ChatArea, channelProps());
  await act(async () => input().props.onChange({ target: { value: 'mensagem pendente' } }));
  await act(async () => input().props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault() {} }));
  assert.equal(socket.sent.filter(([event]) => event === 'enviar-mensagem').length, 0);
  await act(async () => input().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }));
  assert.equal(socket.sent.filter(([event]) => event === 'enviar-mensagem').length, 1);
  assert.equal(input().props.value, 'mensagem pendente');
  assert.equal(input().props.disabled, true);
  await act(async () => socket.receive('disconnect'));
  assert.equal(input().props.value, 'mensagem pendente');
  assert.equal(input().props.disabled, false);
  assert.match(text(), /rascunho foi preservado/);
  await act(async () => socket.receive('connect'));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await act(async () => socket.receive('nova-mensagem', { canalId: 3, mensagem: message({ id: 7, usuario_id: 1, conteudo: 'mensagem pendente' }) }));
  assert.equal(input().props.value, ''); assert.equal(input().props.disabled, false);
});

test('Enter to send desligado usa botão enviar', async () => {
  preferences.enterToSend = false;
  await mount(DirectMessageScreen, dmProps());
  await act(async () => input().props.onChange({ target: { value: 'Olá Ana' } }));
  await act(async () => input().props.onKeyDown({ key: 'Enter', preventDefault() { throw new Error('não deveria prevenir'); } }));
  assert.equal(socket.sent.length, 0);
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(socket.sent[0], ['enviar-dm', { paraUsuarioId: 2, conteudo: 'Olá Ana' }]);
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 1, comUsuarioId: 2, mensagem: message({ remetente_id: 1, conteudo: 'Olá Ana' }) }));
  assert.equal(input().props.value, '');
});

for (const modifier of ['ctrlKey', 'metaKey']) {
  test(`Enter to send desligado permite ${modifier === 'ctrlKey' ? 'Ctrl' : 'Meta'} Enter e preserva Shift Enter`, async () => {
    preferences.enterToSend = false;
    await mount(DirectMessageScreen, dmProps());
    await act(async () => input().props.onChange({ target: { value: 'Olá pelo atalho' } }));
    for (const keys of [{}, { shiftKey: true }, { [modifier]: true, shiftKey: true }]) {
      await act(async () => input().props.onKeyDown({ key: 'Enter', ...keys, preventDefault() { throw new Error('quebra de linha deve ser preservada'); } }));
    }
    assert.equal(socket.sent.length, 0);
    let prevented = 0;
    await act(async () => input().props.onKeyDown({ key: 'Enter', [modifier]: true, preventDefault() { prevented++; } }));
    assert.ok(prevented > 0);
    assert.deepEqual(socket.sent, [['enviar-dm', { paraUsuarioId: 2, conteudo: 'Olá pelo atalho' }]]);
    assert.equal(input().props.disabled, true);
    await act(async () => input().props.onKeyDown({ key: 'Enter', [modifier]: true, preventDefault() { throw new Error('envio pendente não deve ser repetido'); } }));
    assert.equal(socket.sent.length, 1);
    assert.equal(input().props.value, 'Olá pelo atalho');
  });
}

test('DM ignora outra conversa e não mostra chamada nem anexo sem API', async () => {
  await mount(DirectMessageScreen, dmProps());
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 4, comUsuarioId: 1, mensagem: message({ conteudo: 'outra conversa' }) }));
  assert.doesNotMatch(text(), /outra conversa/);
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 2, comUsuarioId: 1, mensagem: message({ conteudo: 'conversa certa' }) }));
  assert.match(text(), /conversa certa/);
  assert.equal(root.root.findAllByType('input').filter((node) => node.props.type === 'file').length, 0);
  assert.equal(root.root.findAllByType('button').some((node) => /chamada/i.test(node.props['aria-label'] || '')), false);
});

test('live durante carregamento do histórico é preservado sem duplicar', async () => {
  let resolveHistory;
  responses.push({ promise: new Promise((resolve) => { resolveHistory = resolve; }) });
  await mount(ChatArea, channelProps());
  await act(async () => socket.receive('nova-mensagem', { canalId: 3, mensagem: message({ id: 2, conteudo: 'chegou agora' }) }));
  await act(async () => resolveHistory({ ok: true, status: 200, json: async () => [message(), message({ id: 2, conteudo: 'chegou agora' })] }));
  assert.equal(root.root.findAllByType('article').length, 2);
  assert.match(text(), /chegou agora/);
});

test('permissão apagar e busca de mensagens funcionam; membro toggle encaminha callback', async () => {
  responses.push({ ok: true, status: 200, data: [message(), message({ id: 2, usuario_id: 1, conteudo: 'minha mensagem' })] });
  let toggled = 0;
  await mount(ChatArea, channelProps({ onToggleMembros: () => toggled++ }));
  assert.equal(root.root.findAllByType('button').filter((node) => node.props['aria-label'] === 'Apagar mensagem').length, 1);
  await act(async () => button('Apagar mensagem').props.onClick());
  assert.ok(socket.sent.some(([name, payload]) => name === 'apagar-mensagem' && payload.mensagemId === 2));
  await act(async () => button('Ocultar membros').props.onClick());
  assert.equal(toggled, 1);
  await act(async () => button('Buscar nesta conversa').props.onClick());
  await act(async () => root.root.findByProps({ 'aria-label': 'Buscar nas mensagens carregadas' }).props.onChange({ target: { value: 'minha' } }));
  assert.equal(root.root.findAllByType('article').length, 1); assert.match(text(), /minha mensagem/);
});

test('preview desligado mantém link do anexo; modo streamer remove conteúdo e preview', async () => {
  preferences.mediaPreviews = false;
  responses.push({ ok: true, status: 200, data: [message({ anexo_url: 'data:image/png;base64,aA==', anexo_tipo: 'image/png', anexo_nome: 'foto.png' })] });
  await mount(ChatArea, channelProps());
  assert.equal(root.root.findAllByType('img').length, 0);
  assert.ok(root.root.findAllByType('a').some((node) => node.props.download === 'foto.png'));
  preferences.streamerMode = true;
  await act(async () => window.dispatchEvent(new Event('astralis:interface-settings')));
  assert.doesNotMatch(text(), /Olá turma/); assert.match(text(), /Conteúdo oculto/);
  assert.equal(root.root.findAllByType('a').length, 0);
});

test('notificação só ocorre para evento entrante, aba oculta e preferência concedida', async () => {
  const notifications = [];
  class Notification { static permission = 'granted'; constructor(title, options) { notifications.push({ title, ...options }); } }
  globalThis.Notification = Notification;
  preferences.desktopNotifications = true;
  document.hidden = true;
  responses.push({ ok: true, status: 200, data: [message()] });
  await mount(DirectMessageScreen, dmProps());
  assert.equal(notifications.length, 0);
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 1, comUsuarioId: 2, mensagem: message({ id: 2, remetente_id: 1 }) }));
  assert.equal(notifications.length, 0);
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 2, comUsuarioId: 1, mensagem: message({ id: 3 }) }));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Ana');
  preferences.streamerMode = true;
  await act(async () => window.dispatchEvent(new Event('astralis:interface-settings')));
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 2, comUsuarioId: 1, mensagem: message({ id: 4 }) }));
  assert.equal(notifications.length, 1);
});

test('modo streamer silencia notificações e som de novas mensagens em segundo plano', async () => {
  let notifications = 0, sounds = 0;
  globalThis.Notification = class { static permission = 'granted'; constructor() { notifications++; } };
  globalThis.AudioContext = class {
    state = 'running'; currentTime = 0; destination = {};
    createOscillator() { return { connect() {}, disconnect() {}, frequency: { setValueAtTime() {} }, start() { sounds++; }, stop() {} }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
    close() { return Promise.resolve(); }
  };
  preferences.desktopNotifications = true;
  preferences.notificationSound = true;
  document.hidden = true;
  await mount(DirectMessageScreen, dmProps());
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 2, comUsuarioId: 1, mensagem: message({ id: 10 }) }));
  assert.equal(notifications, 1); assert.equal(sounds, 1);
  preferences.streamerMode = true;
  await act(async () => window.dispatchEvent(new Event('astralis:interface-settings')));
  await act(async () => socket.receive('nova-dm', { deUsuarioId: 2, comUsuarioId: 1, mensagem: message({ id: 11, conteudo: 'mensagem privada' }) }));
  assert.equal(notifications, 1); assert.equal(sounds, 1);
  assert.match(text(), /Conteúdo oculto no modo streamer/);
  assert.doesNotMatch(text(), /mensagem privada/);
});

test('reconectar reentra canal e atualiza histórico sem ressuscitar mensagens apagadas', async () => {
  responses.push({ ok: true, status: 200, data: [message()] });
  await mount(ChatArea, channelProps());
  assert.equal(root.root.findAllByType('article').length, 1);
  await act(async () => socket.receive('disconnect'));
  responses.push({ ok: true, status: 200, data: [] });
  await act(async () => socket.receive('connect'));
  assert.equal(root.root.findAllByType('article').length, 0);
  assert.equal(socket.sent.filter(([event]) => event === 'entrar-canal').length, 2);
});

test('anexo maior de 5MB é recusado sem perder rascunho e sem emitir mensagem', async () => {
  await mount(ChatArea, channelProps());
  await act(async () => input().props.onChange({ target: { value: 'com anexo' } }));
  await act(async () => root.root.findByProps({ type: 'file' }).props.onChange({ target: { files: [{ name: 'grande.zip', size: 6 * 1024 * 1024 }] } }));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.match(text(), /no máximo 5 MB/); assert.equal(input().props.value, 'com anexo');
  assert.equal(socket.sent.filter(([event]) => event === 'enviar-mensagem').length, 0);
});

test('Enter durante composição IME mantém edição sem emitir mensagem', async () => {
  await mount(DirectMessageScreen, dmProps());
  await act(async () => input().props.onChange({ target: { value: 'こんにちは' } }));
  await act(async () => input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { throw new Error('não deveria prevenir composição'); } }));
  assert.equal(socket.sent.length, 0); assert.equal(input().props.value, 'こんにちは');
});

test('Ctrl ou Meta Enter durante composição IME preserva texto com Enter to send desligado', async () => {
  preferences.enterToSend = false;
  await mount(DirectMessageScreen, dmProps());
  await act(async () => input().props.onChange({ target: { value: 'こんにちは' } }));
  for (const keys of [{ ctrlKey: true, nativeEvent: { isComposing: true } }, { metaKey: true, isComposing: true }]) {
    await act(async () => input().props.onKeyDown({ key: 'Enter', ...keys, preventDefault() { throw new Error('não deveria prevenir composição'); } }));
  }
  assert.equal(socket.sent.length, 0); assert.equal(input().props.value, 'こんにちは');
});
