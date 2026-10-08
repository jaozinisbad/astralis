import assert from 'node:assert/strict';
import { after, before, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = { window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
let vite;
let App;
let renderer;

function stubs() {
  return {
    name: 'app-update-isolated-native-boundaries', enforce: 'pre',
    resolveId(id) {
      if (id === 'socket.io-client') return '\0update-socket';
      const match = id.match(/^\.\/components\/(.+)\.jsx$/);
      return match && match[1] !== 'UpdateBanner' ? '\0update-screen:' + match[1] : null;
    },
    load(id) {
      if (id === '\0update-socket') return 'export const io = () => ({ on() {}, off() {}, once() {}, emit() {}, disconnect() {} });';
      if (!id.startsWith('\0update-screen:')) return null;
      const name = id.slice('\0update-screen:'.length);
      if (name === 'RoomLobby') return `import React from 'react'; export default function RoomLobby(props) {
        return React.createElement('main', { 'data-current-screen': 'lobby' },
          props.onEntrarNaConta ? React.createElement('button', { onClick: props.onEntrarNaConta }, 'Entrar na conta') : null);
      }`;
      if (name === 'StreamRoom') return `import React from 'react'; export default function StreamRoom() {
        return React.createElement('main', { 'data-current-screen': 'stream' });
      }`;
      if (name === 'LoginScreen') return `import React from 'react'; export default function LoginScreen() {
        return React.createElement('main', { 'data-current-screen': 'login' });
      }`;
      return 'export default function Screen() { return null; }';
    },
  };
}

before(async () => {
  vite = await createServer({
    configFile: false, root, plugins: [stubs()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['socket.io-client'] }, appType: 'custom',
  });
  ({ default: App } = await vite.ssrLoadModule('/src/App.jsx'));
});
after(async () => { await vite?.close(); });
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  Object.assign(globalThis, original);
});

function prepare({ loggedIn = false, room = false } = {}) {
  const values = new Map([['settings', '{"volume":37,"theme":"astralis"}']]);
  if (loggedIn) values.set('sessao', JSON.stringify({ token: 'saved-session-token', usuario: { id: 'user-1', nome: 'Jogador', status: 'online' } }));
  const initial = new Map(values);
  const writes = [];
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(['set', key]); values.set(key, value); },
    removeItem: (key) => { writes.push(['remove', key]); values.delete(key); },
  };
  const listeners = new Set();
  const calls = { download: 0, install: 0, check: 0, snapshot: 0 };
  globalThis.window = new EventTarget();
  window.location = { search: room ? '?room=active-room' : '', href: 'https://astralis.test/' + (room ? '?room=active-room' : '') };
  window.history = { replaceState() {} };
  window.electronAPI = {
    obterStatusAtualizacao: () => { calls.snapshot += 1; return Promise.resolve({ status: 'available', version: '9.8.7' }); },
    onAtualizacaoStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    baixarAtualizacao: () => { calls.download += 1; return Promise.resolve({ status: 'downloading', percent: 0 }); },
    reiniciarParaAtualizar: () => { calls.install += 1; return Promise.resolve({ status: 'installing' }); },
    verificarAtualizacao: () => { calls.check += 1; return Promise.resolve({ status: 'checking' }); },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  return { values, initial, writes, calls, listeners, emit: (state) => { for (const listener of listeners) listener(state); } };
}

async function mount() {
  await act(async () => { renderer = TestRenderer.create(React.createElement(App)); await Promise.resolve(); });
}
function banner() { return renderer.root.findByProps({ 'aria-label': 'Atualização do Astralis' }); }

for (const loggedIn of [false, true]) {
  for (const room of [false, true]) {
    test(`the real update banner remains available for ${loggedIn ? 'authenticated' : 'guest'} ${room ? 'stream' : 'lobby'} without changing saved data`, async () => {
      const h = prepare({ loggedIn, room });
      await mount();
      assert.equal(renderer.root.findByProps({ 'data-current-screen': room ? 'stream' : 'lobby' }).type, 'main');
      assert.equal(banner().findByType('button').children.join(''), 'Baixar atualização');
      assert.deepEqual(h.calls, { download: 0, install: 0, check: 0, snapshot: 1 });
      await act(async () => h.emit({ status: 'downloaded', version: '9.8.7' }));
      assert.equal(banner().findByType('button').children.join(''), 'Reiniciar e instalar');
      assert.deepEqual(h.values, h.initial);
      assert.deepEqual(h.writes, []);
      assert.equal(h.calls.install, 0);
      assert.equal(h.listeners.size, 1);
    });
  }
}

test('the update banner survives navigation from guest lobby to login without resetting subscription or storage', async () => {
  const h = prepare();
  await mount();
  await act(async () => renderer.root.findAllByType('button').find((node) => node.children.join('') === 'Entrar na conta').props.onClick());
  assert.ok(renderer.root.findByProps({ 'data-current-screen': 'login' }));
  assert.equal(h.calls.snapshot, 1);
  assert.equal(h.listeners.size, 1);
  await act(async () => h.emit({ status: 'downloaded', version: '9.8.7' }));
  assert.equal(banner().findByType('button').children.join(''), 'Reiniciar e instalar');
  assert.deepEqual(h.values, h.initial);
  assert.deepEqual(h.writes, []);
  assert.equal(h.calls.install, 0);
});
