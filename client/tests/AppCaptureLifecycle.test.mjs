import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite;
let App;
let renderer;
const original = Object.fromEntries(['window', 'navigator', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

function boundaryStubs() {
  return {
    name: 'app-capture-boundaries', enforce: 'pre',
    resolveId(id) {
      if (id === 'socket.io-client') return '\0capture-socket';
      const component = id.match(/^\.\/components\/(.+)\.jsx$/);
      if (component && ['HomeSidebar', 'DesktopTitlebar'].includes(component[1])) return null;
      return component ? '\0capture-component:' + component[1] : null;
    },
    load(id) {
      if (id === '\0capture-socket') return 'export const io = () => ({ on() {}, off() {}, emit() {}, disconnect() {} });';
      if (!id.startsWith('\0capture-component:')) return null;
      const name = id.slice('\0capture-component:'.length);
      if (name === 'StreamRoom') return `import React from 'react'; export default function StreamRoom(props) {
        return React.createElement('main', { 'data-room': props.roomId, 'data-stream': props.localStream?.id || '' },
          React.createElement('button', { onClick: props.onRequestShare }, 'Abrir captura'),
          React.createElement('button', { onClick: props.onExit }, 'Sair da sala'));
      }`;
      if (name === 'ScreenShareSourcePicker') return `import React from 'react'; export default function Picker(props) {
        return React.createElement('aside', null,
          React.createElement('button', { onClick: () => props.onSelecionar({ fonteId: 'screen:1:0', shareAudio: false }) }, 'Iniciar captura'),
          React.createElement('button', { onClick: props.onFechar }, 'Cancelar captura'));
      }`;
      return 'export default function Boundary() { return null; }';
    },
  };
}

before(async () => {
  vite = await createServer({
    configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), plugins: [boundaryStubs()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['socket.io-client'] }, appType: 'custom',
  });
  ({ default: App } = await vite.ssrLoadModule('/src/App.jsx'));
});
after(async () => vite?.close());
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function media(id) {
  const video = { kind: 'video', addEventListener() {}, stop() { this.stopped = true; } };
  return { id, video, getTracks: () => [video], getAudioTracks: () => [], getVideoTracks: () => [video] };
}

async function mount() {
  const pending = [];
  const windowValue = new EventTarget();
  windowValue.location = { search: '?room=active-room', href: 'https://astralis.test/?room=active-room' };
  windowValue.history = { replaceState() {} };
  const values = {
    window: windowValue,
    localStorage: { getItem: () => null },
    navigator: { mediaDevices: { getDisplayMedia: () => new Promise((resolve) => pending.push(resolve)) } },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  await act(async () => { renderer = TestRenderer.create(React.createElement(App)); });
  return pending;
}
async function click(label) {
  await act(async () => renderer.root.findAllByType('button').find((node) => node.children.includes(label)).props.onClick());
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('room capture lifecycle: leaving during permission prompt disposes the granted stream', async () => {
  const pending = await mount();
  await click('Abrir captura');
  await click('Iniciar captura');
  await click('Sair da sala');
  const late = media('late');
  await act(async () => { pending[0](late); await flush(); });
  assert.equal(late.video.stopped, true);
  assert.equal(renderer.root.findAllByType('main').length, 0);
});

test('room capture lifecycle: cancelling and replacing a pending request cannot overwrite the newer stream', async () => {
  const pending = await mount();
  await click('Abrir captura');
  await click('Iniciar captura');
  await click('Cancelar captura');
  await click('Abrir captura');
  await click('Iniciar captura');
  const replacement = media('current');
  await act(async () => { pending[1](replacement); await flush(); });
  assert.equal(renderer.root.findByType('main').props['data-stream'], 'current');
  const obsolete = media('obsolete');
  await act(async () => { pending[0](obsolete); await flush(); });
  assert.equal(obsolete.video.stopped, true);
  assert.notEqual(replacement.video.stopped, true);
  assert.equal(renderer.root.findByType('main').props['data-stream'], 'current');
});

test('room capture lifecycle: unmount disposes a subsequently granted stream', async () => {
  const pending = await mount();
  await click('Abrir captura');
  await click('Iniciar captura');
  await act(async () => renderer.unmount());
  renderer = null;
  const late = media('late');
  await act(async () => { pending[0](late); await flush(); });
  assert.equal(late.video.stopped, true);
});
