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

test('picker starts a new transmission at Full HD 60 fps with the internal budget and Discord excluded', async () => {
  const selections = await mount();
  assert.equal(renderer.root.findAllByType('select').length, 1);
  assert.equal(renderer.root.findByType('select').props.value, '1080p');
  assert.equal(renderer.root.findAllByType('input').filter((node) => node.props.type === 'checkbox').length, 2);
  const labels = renderer.root.findAllByType('label').map((node) => JSON.stringify(node.children.filter((child) => typeof child === 'string'))).join(' ');
  assert.doesNotMatch(labels, /Bitrate|Taxa de quadros|Não enviar o áudio do Discord/);

  await act(async () => button('Compartilhar').props.onClick());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].resolution, '1080p');
  assert.equal(selections[0].fps, 60);
  assert.equal(selections[0].bitrate, 16_000_000);
  assert.equal(selections[0].ignoreDiscordAudio, true);
  assert.equal(selections[0].fonteId, 'screen:1:0');
});

test('picker allows a lower resolution while keeping the automatic rate and Discord protection', async () => {
  const selections = await mount();
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: '720p' } }));
  const windowButton = renderer.root.findAllByType('button').find((node) => node.props.className?.includes('screen-picker-item')
    && node.findAllByType('span').some((span) => span.children.includes('Jogo')));
  await act(async () => windowButton.props.onClick());
  await act(async () => button('Compartilhar').props.onClick());
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
    let pending;
    await act(async () => { pending = button('Compartilhar').props.onClick(); });
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
