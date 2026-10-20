import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite, FriendsScreen, root, preferences;
const original = new Map();
const ana = { id: 2, nome: 'Ana', online: true, avatar_url: 'https://example.test/ana.png' };
const bruno = { id: 3, nome: 'Bruno', online: false };
const pedidos = { recebidos: [{ id: 17, usuario: ana }], enviados: [{ id: 22, usuario: bruno }] };

before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ default: FriendsScreen } = await vite.ssrLoadModule('/src/components/FriendsScreen.jsx'));
});
after(async () => { await vite?.close(); });
beforeEach(() => {
  for (const key of ['window', 'document', 'localStorage']) original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  preferences = {};
  globalThis.localStorage = { getItem: () => JSON.stringify(preferences), setItem() {} };
  globalThis.window = new EventTarget();
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } } };
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = null;
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  original.clear();
});
async function mount(props = {}) { await act(async () => { root = TestRenderer.create(React.createElement(FriendsScreen, props)); }); }
function text() { return root.root.findAll((node) => typeof node.type === 'string').flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' '); }
function button(name) { return root.root.findAllByType('button').find((node) => node.props['aria-label'] === name || node.children.includes(name)); }
async function click(name) { await act(async () => { await button(name).props.onClick(); }); }
async function typeName(value) { await act(async () => root.root.findByProps({ id: 'friend-name' }).props.onChange({ target: { value } })); }
async function submit() { await act(async () => { await root.root.findByType('form').props.onSubmit({ preventDefault() {} }); }); }

test('nome ou código é enviado uma vez; resposta pendente bloqueia submissões repetidas', async () => {
  const sent = [];
  let resolve;
  await mount({ meuUsuario: { id: 8, nome: 'João' }, onAdicionarAmigo: (name) => { sent.push(name); return new Promise((done) => { resolve = done; }); } });
  await click('Adicionar amigo');
  assert.match(text(), /João#8/);
  assert.equal(button('Enviar pedido de amizade').props.disabled, true);
  await typeName('  Ana#2  ');
  const form = root.root.findByType('form');
  await act(async () => { void form.props.onSubmit({ preventDefault() {} }); void form.props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(sent, ['Ana#2']);
  assert.equal(button('Enviando…').props.disabled, true);
  assert.equal(root.root.findByProps({ id: 'friend-name' }).props.disabled, true);
  await act(async () => { resolve(); });
  assert.match(text(), /Pedido de amizade enviado/);
  assert.equal(root.root.findByProps({ id: 'friend-name' }).props.value, '');
});

test('erro ao adicionar preserva nome, mostra mensagem e permite corrigir ou tentar novamente', async () => {
  let attempts = 0;
  await mount({ onAdicionarAmigo: async () => { if (++attempts === 1) throw new Error('Nome ambíguo. Use o código.'); } });
  await click('Adicionar amigo');
  await typeName('Ana');
  await submit();
  assert.match(text(), /Nome ambíguo/);
  assert.equal(root.root.findByProps({ id: 'friend-name' }).props.value, 'Ana');
  assert.equal(button('Enviar pedido de amizade').props.disabled, false);
  await typeName('#2');
  await submit();
  assert.equal(attempts, 2);
  assert.doesNotMatch(text(), /Nome ambíguo/);
  assert.match(text(), /Pedido de amizade enviado/);
});

test('pedidos recebidos aceitam e recusam, pedidos enviados cancelam usando o ID do pedido', async () => {
  const accepted = [], declined = [];
  await mount({ pedidos, onAceitarPedido: async (id) => accepted.push(id), onRecusarPedido: async (id) => declined.push(id) });
  await click('Pendentes');
  assert.match(text(), /Pedido recebido/);
  assert.match(text(), /Pedido enviado/);
  assert.equal(button('Aceitar pedido de Bruno'), undefined);
  await click('Aceitar pedido de Ana');
  await click('Recusar pedido de Ana');
  await click('Cancelar pedido para Bruno');
  assert.deepEqual(accepted, [17]);
  assert.deepEqual(declined, [17, 22]);
});

test('ações de conversa, ligação e remoção são separadas sem botões aninhados', async () => {
  const opened = [], called = [], removed = [];
  await mount({ amigos: [ana, bruno], onAbrirDM: (friend) => opened.push(friend.id), onLigar: async (friend) => called.push(friend.id), onRemoverAmigo: async (id) => removed.push(id) });
  await click('Todos');
  for (const node of root.root.findAllByType('button')) assert.equal(node.findAllByType('button').length, 1);
  assert.equal(button('Ligar para Bruno').props.disabled, true);
  await click('Conversar com Ana');
  await click('Ligar para Ana');
  await click('Remover Bruno dos amigos');
  assert.deepEqual(opened, [2]);
  assert.deepEqual(called, [2]);
  assert.deepEqual(removed, [3]);
});

test('falha na ligação fica visível sem abrir conversa ou remover amigo', async () => {
  let opened = 0, removed = 0;
  await mount({ amigos: [ana], onAbrirDM: () => opened++, onLigar: async () => { throw new Error('Este amigo já está em uma chamada.'); }, onRemoverAmigo: () => removed++ });
  await click('Ligar para Ana');
  assert.match(text(), /já está em uma chamada/);
  assert.equal(opened, 0);
  assert.equal(removed, 0);
  assert.equal(button('Ligar para Ana').props.disabled, false);
});

test('visitante é encaminhado ao login e não vê formulário de envio', async () => {
  let signedIn = 0, sent = 0;
  await mount({ onEntrarNaConta: () => signedIn++, onAdicionarAmigo: () => sent++ });
  await click('Adicionar amigo');
  assert.equal(root.root.findAllByType('form').length, 0);
  await click('Entrar na conta');
  assert.equal(signedIn, 1);
  assert.equal(sent, 0);
});

test('modo streamer oculta nomes, fotos, códigos e labels também nos pedidos', async () => {
  preferences.streamerMode = true;
  await mount({ amigos: [ana], pedidos, meuUsuario: { id: 8, nome: 'João' }, onAbrirDM() {}, onAceitarPedido() {}, onRecusarPedido() {} });
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /Ana|João|ana\.png/);
  await click('Pendentes');
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /Ana|Bruno|ana\.png/);
  await click('Adicionar amigo');
  assert.match(text(), /Oculto no modo streamer/);
  assert.doesNotMatch(text(), /João#8/);
  assert.equal(root.root.findByProps({ id: 'friend-name' }).props.type, 'password');
});

test('falha ao carregar e carregamento não afirmam que a lista está vazia', async () => {
  let retried = 0;
  await mount({ erro: 'Falha ao carregar amigos.', onTentarNovamente: () => retried++ });
  assert.match(text(), /Falha ao carregar amigos/);
  assert.doesNotMatch(text(), /A sua turma começa aqui|Por enquanto está quieto/);
  await click('Tentar novamente');
  assert.equal(retried, 1);
  await click('Pendentes');
  assert.doesNotMatch(text(), /Nenhum pedido pendente/);
  await act(async () => { root.update(React.createElement(FriendsScreen, { carregando: true })); });
  assert.match(text(), /Carregando amigos/);
  assert.doesNotMatch(text(), /Nenhum pedido pendente/);
});
