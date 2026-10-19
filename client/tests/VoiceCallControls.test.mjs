import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Panel, Stage, getStatus;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } }, appType: 'custom' });
  ({ default: Panel, getVoicePanelStatus: getStatus } = await vite.ssrLoadModule('/src/components/VoiceConnectionPanel.jsx'));
  ({ default: Stage } = await vite.ssrLoadModule('/src/components/VoiceCallStage.jsx'));
});
after(async () => vite?.close());

test('voice panel requires the server-confirmed connection before claiming voice is connected', () => {
  for (const state of [{}, { conectando: false }, { connectionState: 'connecting' }, { connectionState: 'reconnecting' }]) {
    assert.equal(getStatus(state).id, 'connecting');
  }
  assert.equal(getStatus({ connectionState: 'connected' }).label, 'Voz conectada');
  for (const state of [{ connectionState: 'disconnected' }, { connectionState: 'failed' }, { erro: 'Microfone bloqueado' }]) {
    assert.equal(getStatus(state).id, 'failed');
  }
});

test('persistent panel routes share, change source, stop, return and disconnect to the active call', () => {
  const events = [];
  const channel = { nome: 'Jogatina', servidorNome: 'Órbita' };
  const actions = Object.fromEntries(['onIniciarTela','onTrocarFonte','onPararTela','onAbrirChamada','onDesconectar'].map(name => [name, () => events.push(name)]));
  let renderer;
  const render = state => React.createElement(Panel, { channel, state, actions });
  try {
    act(() => { renderer = TestRenderer.create(render({ connectionState: 'connecting' })); });
    assert.equal(renderer.root.findByProps({ 'aria-label': 'Compartilhar tela' }).props.disabled, true);
    act(() => renderer.update(render({ connectionState: 'connected' })));
    const click = label => act(() => renderer.root.findByProps({ 'aria-label': label }).props.onClick());
    click('Compartilhar tela'); click('Voltar à chamada Jogatina / Órbita');
    act(() => renderer.update(render({ connectionState: 'connected', compartilhandoTela: true })));
    click('Trocar fonte de compartilhamento'); click('Parar compartilhamento de tela'); click('Desconectar da chamada');
    assert.deepEqual(events, ['onIniciarTela','onAbrirChamada','onTrocarFonte','onPararTela','onDesconectar']);
    act(() => renderer.update(render({ connectionState: 'connected', compartilhandoTela: true, compartilhamentoPendente: true })));
    assert.equal(renderer.root.findByProps({ 'aria-label': 'Trocar fonte de compartilhamento' }).props.disabled, true);
  } finally { act(() => renderer?.unmount()); }
});

test('call stage uses real participants, watch controls and disabled sharing before connection', () => {
  const props = { canal: { nome: 'Jogatina' }, socketId: 'me', participantes: [{ socketId: 'me', nome: 'Órion' }, { socketId: 'friend', nome: 'Vega' }],
    connectionState: 'connecting', telasRemotas: { friend: {} }, telasMutadas: new Set(), volumesTelas: {}, onCompartilharTela() {} };
  let renderer;
  try {
    act(() => { renderer = TestRenderer.create(React.createElement(Stage, props)); });
    assert.equal(renderer.root.findAllByType('article').length, 2);
    assert.equal(renderer.root.findByProps({ 'aria-label': 'Compartilhar sua tela' }).props.disabled, true);
    assert.ok(renderer.root.findByProps({ 'aria-label': 'Assistir transmissão de Vega' }));
    act(() => renderer.update(React.createElement(Stage, { ...props, connectionState: 'connected' })));
    assert.equal(renderer.root.findByProps({ 'aria-label': 'Compartilhar sua tela' }).props.disabled, false);
    act(() => renderer.update(React.createElement(Stage, { ...props, connectionState: 'disconnected' })));
    assert.match(renderToStaticMarkup(React.createElement(Stage, { ...props, connectionState: 'disconnected' })), /voice-stage__connection--error/);
    assert.equal(renderer.root.findByProps({ 'aria-label': 'Silenciar microfone' }).props.disabled, true);
  } finally { act(() => renderer?.unmount()); }
});
