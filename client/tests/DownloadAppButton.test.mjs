import assert from 'node:assert/strict';
import { after, before, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = { window: globalThis.window, fetch: globalThis.fetch, __fetchLatestInstallerTest: globalThis.__fetchLatestInstallerTest };
let vite;
let DownloadAppButton;
let RoomLobby;
let LoginScreen;
let renderer;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function installer(version = '1.5.3') {
  return { version, filename: 'Astralis-Setup-' + version + '.exe',
    url: 'https://github.com/jaozinisbad/astralis/releases/download/v' + version + '/Astralis-Setup-' + version + '.exe' };
}
function helperStub() {
  return {
    name: 'download-app-lookup-boundary', enforce: 'pre',
    resolveId(id) { return id.endsWith('/appDownload.mjs') ? '\0download-app-helper' : null; },
    load(id) { return id === '\0download-app-helper'
      ? 'export const fetchLatestWindowsInstaller = (options) => globalThis.__fetchLatestInstallerTest(options);' : null; },
  };
}
before(async () => {
  vite = await createServer({
    configFile: false, root, plugins: [helperStub()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  ({ default: DownloadAppButton } = await vite.ssrLoadModule('/src/components/DownloadAppButton.jsx'));
  ({ default: RoomLobby } = await vite.ssrLoadModule('/src/components/RoomLobby.jsx'));
  ({ default: LoginScreen } = await vite.ssrLoadModule('/src/components/LoginScreen.jsx'));
});
after(async () => { await vite?.close(); });
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  Object.assign(globalThis, original);
});
function prepare(lookup = async () => installer()) {
  const calls = [];
  const navigations = [];
  globalThis.window = { location: { assign: (url) => navigations.push(url) } };
  globalThis.__fetchLatestInstallerTest = (options) => { calls.push(options); return lookup(options); };
  return { calls, navigations };
}
async function mount(props = {}) {
  await act(async () => { renderer = TestRenderer.create(React.createElement(DownloadAppButton, props)); await Promise.resolve(); });
}
function text() {
  return renderer.root.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ');
}
function button() { return renderer.root.findByType('button'); }

test('does not look up releases or navigate on mount and identifies the target as Windows', async () => {
  const h = prepare();
  await mount();
  assert.match(text(), /Baixar para Windows/);
  assert.equal(button().props.type, 'button');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.navigations, []);
  await act(async () => renderer.unmount());
  renderer = null;
  assert.equal(h.calls.length, 0);
});

test('a click looks up the latest asset and navigates straight to its attachment URL', async () => {
  const h = prepare();
  await mount();
  await act(async () => button().props.onClick());
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].signal instanceof AbortSignal);
  assert.deepEqual(h.navigations, [installer().url]);
  assert.equal(h.navigations.some((url) => /\/releases\/tag\//.test(url)), false);
  assert.match(text(), /Baixar novamente/);
});

test('shows preparation and deduplicates rapid clicks during the same lookup', async () => {
  const pending = deferred();
  const h = prepare(() => pending.promise);
  await mount();
  const click = button().props.onClick;
  let first;
  let second;
  await act(async () => { first = click(); second = click(); await Promise.resolve(); });
  assert.equal(h.calls.length, 1);
  assert.equal(button().props.disabled, true);
  assert.match(text(), /Preparando download/);
  assert.deepEqual(h.navigations, []);
  await act(async () => { pending.resolve(installer()); await Promise.all([first, second]); });
  assert.deepEqual(h.navigations, [installer().url]);
});

test('a later download click consults latest again and uses the future release URL', async () => {
  let request = 0;
  const h = prepare(async () => installer(++request === 1 ? '1.5.3' : '2.0.0'));
  await mount();
  await act(async () => button().props.onClick());
  await act(async () => button().props.onClick());
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.navigations, [installer('1.5.3').url, installer('2.0.0').url]);
});

test('a lookup failure displays the error and retries only on another click', async () => {
  let request = 0;
  const h = prepare(async () => {
    if (++request === 1) throw new Error('Limite de consultas do GitHub. Tente novamente em instantes.');
    return installer();
  });
  await mount();
  await act(async () => button().props.onClick());
  assert.ok(renderer.root.findByProps({ role: 'alert' }));
  assert.match(text(), /Limite de consultas/);
  assert.match(text(), /Tentar novamente/);
  assert.equal(button().props.disabled, false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.navigations, []);
  await act(async () => button().props.onClick());
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.navigations, [installer().url]);
});

test('unmount aborts the pending lookup and ignores a late success without navigating', async () => {
  const pending = deferred();
  const h = prepare(() => pending.promise);
  await mount();
  let request;
  await act(async () => { request = button().props.onClick(); await Promise.resolve(); });
  assert.equal(h.calls[0].signal.aborted, false);
  await act(async () => renderer.unmount());
  renderer = null;
  assert.equal(h.calls[0].signal.aborted, true);
  await act(async () => { pending.resolve(installer()); await request; });
  assert.deepEqual(h.navigations, []);
});

test('is hidden inside Electron and never performs a web lookup there', async () => {
  const h = prepare();
  window.electronAPI = {};
  await mount();
  assert.equal(renderer.toJSON(), null);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.navigations, []);
});

test('the login variant makes its desktop-app purpose clear', async () => {
  prepare();
  await mount({ variant: 'login' });
  assert.match(text(), /Prefere usar o app/);
  assert.match(text(), /Baixar para Windows/);
});

test('the lobby offers the download to guests and signed-in users without starting a lookup', async () => {
  const h = prepare();
  await act(async () => { renderer = TestRenderer.create(React.createElement(RoomLobby, { usuario: null })); });
  assert.match(text(), /Baixar para Windows/);
  assert.ok(renderer.root.findByProps({ 'aria-label': 'Entrar na conta' }));
  await act(async () => { renderer.update(React.createElement(RoomLobby, { usuario: { nome: 'Luna' } })); });
  assert.match(text(), /Baixar para Windows/);
  assert.ok(renderer.root.findByProps({ 'aria-label': 'Abrir perfil' }));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.navigations, []);
});

test('the login screen offers a separate download button without submitting credentials', async () => {
  const h = prepare();
  const serverRequests = [];
  globalThis.fetch = async (url) => {
    serverRequests.push(String(url));
    return { ok: true };
  };
  const authentications = [];
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(LoginScreen, { onAutenticado: (...args) => authentications.push(args) }));
  });
  const downloadButton = renderer.root.findByProps({ className: 'download-app__button' });
  assert.equal(downloadButton.props.type, 'button');
  assert.equal(renderer.root.findByType('form').findAllByProps({ className: 'download-app__button' }).length, 0);
  assert.equal(h.calls.length, 0);
  await act(async () => downloadButton.props.onClick());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.navigations, [installer().url]);
  assert.deepEqual(authentications, []);
  assert.equal(serverRequests.some((url) => /\/api\/(login|cadastro)/.test(url)), false);
});

test('mobile user agents show no installer button or guidance and never query releases', async () => {
  const userAgents = [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) Mobile Safari/537.36',
    'Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; IEMobile/10.0; ARM)',
  ];
  for (const userAgent of userAgents) {
    for (const variant of ['compact', 'login']) {
      const h = prepare();
      window.navigator = { userAgent };
      await mount({ variant });
      assert.equal(renderer.toJSON(), null, variant + ' should be absent on ' + userAgent);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(h.navigations, []);
      await act(async () => renderer.unmount());
      renderer = null;
    }
  }
});

test('mobile client hints hide installer content even when the user agent string is ambiguous', async () => {
  const h = prepare();
  window.navigator = { userAgent: 'Mozilla/5.0', userAgentData: { mobile: true } };
  await mount();
  assert.equal(renderer.toJSON(), null);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.navigations, []);
});
