import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
let vite;
let ChannelSidebar;
let rendered;

before(async () => {
  vite = await createServer({ configFile: false, root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } }, appType: 'custom' });
  ({ default: ChannelSidebar } = await vite.ssrLoadModule('/src/components/ChannelSidebar.jsx'));
});
after(async () => { await vite?.close(); });
afterEach(() => {
  act(() => rendered?.unmount());
  rendered = undefined;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

function props(overrides = {}) {
  return {
    servidorNome: 'Orbital', codigoConvite: 'ORBITAL1', souDono: false,
    canais: [{ id: 'text-1', nome: 'geral', tipo: 'texto' }, { id: 'voice-1', nome: 'Jogatina', tipo: 'voz' }],
    canalAtivoId: 'text-1', usuario: { id: 'me', nome: 'Luna' },
    onSelecionar() {}, onAbrirPerfil() {}, onAbrirConfiguracao() {}, onSair() {},
    ...overrides,
  };
}

function mount(options = {}) {
  globalThis.window = { clearTimeout, setTimeout, confirm: () => true };
  globalThis.document = new EventTarget();
  act(() => { rendered = TestRenderer.create(React.createElement(ChannelSidebar, props(options))); });
  return rendered.root;
}

test('canais usam botões nativos e apenas o canal atual é marcado', () => {
  const markup = renderToStaticMarkup(React.createElement(ChannelSidebar, props()));
  assert.match(markup, /<aside class="channel-sidebar" aria-label="Canais de Orbital"/);
  assert.match(markup, /<button[^>]+aria-label="Abrir canal de texto geral" aria-current="page"/);
  assert.match(markup, /<button[^>]+aria-label="Abrir canal de voz Jogatina"/);
  assert.equal((markup.match(/aria-current="page"/g) || []).length, 1);
  assert.equal(markup.includes('Apagar canal'), false);
});

test('selecionar texto e voz envia o canal completo para o callback', () => {
  const selected = [];
  const tree = mount({ onSelecionar: (channel) => selected.push(channel) });
  act(() => tree.findByProps({ 'aria-label': 'Abrir canal de texto geral' }).props.onClick());
  act(() => tree.findByProps({ 'aria-label': 'Abrir canal de voz Jogatina' }).props.onClick());
  assert.deepEqual(selected.map((channel) => [channel.id, channel.tipo]), [['text-1', 'texto'], ['voice-1', 'voz']]);
});

test('apagar mantém botão irmão e permissão de gerenciamento', () => {
  const deleted = [];
  const selected = [];
  const tree = mount({ minhasPermissoes: { gerenciar_canais: true }, onApagarCanal: (id) => deleted.push(id), onSelecionar: (channel) => selected.push(channel) });
  const remove = tree.findByProps({ 'aria-label': 'Apagar canal geral' });
  assert.equal(remove.parent.type, 'div');
  assert.equal(remove.parent.props.className, 'channel-item active');
  act(() => remove.props.onClick({ stopPropagation() {} }));
  assert.deepEqual(deleted, ['text-1']);
  assert.deepEqual(selected, []);
});

test('transmissão de participante e configurações continuam funcionais', () => {
  const streams = [];
  let settings = 0;
  const tree = mount({ canalDeVoz: { id: 'voice-1', nome: 'Jogatina' }, nomeUsuarioNaVoz: 'Luna',
    presencaVoz: { 'voice-1': [{ socketId: 'remote', usuarioId: 'u2', nome: 'Sol' }] },
    vozEstado: { telasAtivas: ['remote'], telaSelecionadaId: null }, vozAcoes: {},
    onAssistirTransmissao: (id) => streams.push(id), onAbrirConfiguracao: () => settings++,
  });
  act(() => tree.findByProps({ title: 'Assistir a transmissão de Sol' }).props.onClick());
  act(() => tree.findByProps({ 'aria-label': 'Configurações de usuário' }).props.onClick());
  assert.deepEqual(streams, ['remote']);
  assert.equal(settings, 1);
});
