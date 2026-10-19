import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite;
let Picker;
let renderer;
const previousWindow = globalThis.window;

before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });
  ({ default: Picker } = await vite.ssrLoadModule('/src/components/ScreenShareSourcePicker.jsx'));
});

after(async () => { await vite?.close(); });
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  globalThis.window = previousWindow;
});

async function mount() {
  const selections = [];
  globalThis.window = { electronAPI: {
    listarFontesCompartilhamento: async () => [
      { id: 'screen:1:0', tipo: 'tela', name: 'Tela 1' },
      { id: 'window:42:0', tipo: 'janela', name: 'Jogo' },
    ],
  } };
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Picker, {
      onSelecionar: (value) => selections.push(value), onFechar() {},
    }));
  });
  return selections;
}

function button(name) {
  return renderer.root.findAllByType('button').find((node) => node.children.includes(name));
}

async function choose(source, tab) {
  if (tab) await act(async () => button(tab).props.onClick());
  await act(async () => renderer.root.findByProps({ 'aria-label': `Compartilhar ${source}` }).props.onClick());
  await act(async () => button('Avançar').props.onClick());
}

test('picker starts a new transmission at Full HD 60 fps with the internal budget and Discord excluded', async () => {
  const selections = await mount();
  assert.equal(button('Avançar').props.disabled, true, 'capture must require an explicit source');
  assert.equal(selections.length, 0);
  await choose('Tela 1', 'Telas');
  assert.equal(renderer.root.findAllByType('select').length, 1);
  assert.equal(renderer.root.findByType('select').props.value, '1080p');
  assert.equal(renderer.root.findAllByType('input').filter((node) => node.props.type === 'checkbox').length, 2);
  const labels = renderer.root.findAllByType('label').map((node) => JSON.stringify(node.children.filter((child) => typeof child === 'string'))).join(' ');
  assert.doesNotMatch(labels, /Bitrate|Taxa de quadros|Não enviar o áudio do Discord/);

  await act(async () => button('Transmitir ao vivo').props.onClick());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].resolution, '1080p');
  assert.equal(selections[0].fps, 60);
  assert.equal(selections[0].bitrate, 16_000_000);
  assert.equal(selections[0].ignoreDiscordAudio, true);
  assert.equal(selections[0].fonteId, 'screen:1:0');
});

test('picker allows a lower resolution while keeping the automatic rate and Discord protection', async () => {
  const selections = await mount();
  await choose('Jogo');
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: '720p' } }));
  await act(async () => button('Transmitir ao vivo').props.onClick());
  assert.equal(selections[0].resolution, '720p');
  assert.equal(selections[0].fps, 60);
  assert.equal(selections[0].bitrate, 16_000_000);
  assert.equal(selections[0].ignoreDiscordAudio, true);
  assert.equal(selections[0].fonteId, 'window:42:0');
  assert.equal(selections[0].modoCaptura, 'compatibilidade');
});

test('picker disposes a browser capture granted after its cancel button is pressed', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const selections = [];
  let grantCapture;
  let closed = 0;
  const video = { kind: 'video', stop() { this.stopped = true; } };
  const stream = { getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => [] };
  globalThis.window = {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getDisplayMedia: () => new Promise((resolve) => { grantCapture = resolve; }),
  } } });
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Picker, {
        onSelecionar: (value) => selections.push(value), onFechar: () => { closed += 1; },
      }));
    });
    await choose('Escolher no navegador');
    let pending;
    await act(async () => { pending = button('Transmitir ao vivo').props.onClick(); });
    await act(async () => button('Cancelar').props.onClick());
    assert.equal(closed, 1);
    await act(async () => { grantCapture(stream); await pending; });
    assert.equal(selections.length, 0, 'cancelled picker must never publish a late capture');
    assert.equal(video.stopped, true);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

test('source and confirmation remain separate, and back preserves quality without publishing', async () => {
  const selections = await mount();
  await choose('Jogo');
  assert.equal(selections.length, 0);
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: '720p' } }));
  await act(async () => button('Voltar').props.onClick());
  assert.equal(renderer.root.findByProps({ 'aria-label': 'Compartilhar Jogo' }).props['aria-pressed'], true);
  await act(async () => button('Telas').props.onClick());
  assert.equal(button('Avançar').props.disabled, true, 'a hidden source cannot advance from another tab');
  await choose('Tela 1');
  assert.equal(renderer.root.findByType('select').props.value, '720p');
  assert.equal(selections.length, 0);
  await act(async () => button('Transmitir ao vivo').props.onClick());
  assert.equal(selections[0].fonteId, 'screen:1:0');
});

test('source enumeration can be retried and call confirmation names the destination', async () => {
  let attempts = 0;
  globalThis.window = { electronAPI: { listarFontesCompartilhamento: async () => {
    if (++attempts === 1) throw new Error('Temporary failure');
    return [{ id: 'window:2:0', name: 'Jogo', tipo: 'janela' }];
  } } };
  await act(async () => { renderer = TestRenderer.create(React.createElement(Picker, {
    contexto: 'call', canalNome: 'Jogatina', onSelecionar() {}, onFechar() {},
  })); });
  assert.match(JSON.stringify(renderer.toJSON()), /Não foi possível carregar/);
  await act(async () => button('Tentar novamente').props.onClick());
  await choose('Jogo');
  assert.match(JSON.stringify(renderer.toJSON()), /Jogatina/);
  assert.match(JSON.stringify(renderer.toJSON()), /CANAL DE VOZ/);
});
