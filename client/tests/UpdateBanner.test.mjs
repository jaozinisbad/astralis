import assert from 'node:assert/strict';
import { after, before, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalWindow = globalThis.window;
let vite;
let UpdateBanner;
let renderer;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

before(async () => {
  vite = await createServer({
    configFile: false, root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  ({ default: UpdateBanner } = await vite.ssrLoadModule('/src/components/UpdateBanner.jsx'));
});

after(async () => { await vite?.close(); });
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  globalThis.window = originalWindow;
});

function bridge(initial = { status: 'idle', message: '' }, overrides = {}) {
  const listeners = new Set();
  const calls = { snapshot: 0, check: 0, download: 0, install: 0, removed: 0 };
  const api = {
    obterStatusAtualizacao() { calls.snapshot += 1; return Promise.resolve(initial); },
    onAtualizacaoStatus(listener) {
      listeners.add(listener);
      return () => { calls.removed += 1; listeners.delete(listener); };
    },
    verificarAtualizacao() { calls.check += 1; return Promise.resolve({ status: 'checking' }); },
    baixarAtualizacao() { calls.download += 1; return Promise.resolve({ status: 'downloading', percent: 0, version: '9.8.7' }); },
    reiniciarParaAtualizar() { calls.install += 1; return Promise.resolve({ status: 'installing', version: '9.8.7' }); },
    ...overrides,
  };
  globalThis.window = { electronAPI: api };
  return { api, calls, listeners, emit: (state) => { for (const listener of listeners) listener(state); } };
}

async function mount() {
  await act(async () => { renderer = TestRenderer.create(React.createElement(UpdateBanner)); await Promise.resolve(); });
}

function text() {
  return renderer.root.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ');
}
function button() { return renderer.root.findByType('button'); }
const available = { status: 'available', version: '9.8.7', message: 'Uma atualização está disponível.' };
const downloaded = { status: 'downloaded', version: '9.8.7', percent: 100, message: 'Atualização pronta.' };

test('browser usage and idle state render without update controls or automatic operations', async () => {
  globalThis.window = {};
  await mount();
  assert.equal(renderer.toJSON(), null);
  await act(async () => renderer.unmount());
  renderer = null;
  const h = bridge();
  await mount();
  assert.equal(renderer.toJSON(), null);
  assert.equal(h.calls.snapshot, 1);
  assert.equal(h.calls.check, 0);
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install, 0);
});

test('availability offers a download button and calls download only on click', async () => {
  const h = bridge(available);
  await mount();
  assert.match(text(), /9\.8\.7/);
  assert.match(text(), /Baixar atualização/);
  assert.equal(h.calls.download, 0);
  await act(async () => button().props.onClick());
  assert.equal(h.calls.download, 1);
  assert.equal(h.calls.check, 0);
  assert.equal(h.calls.install, 0);
  assert.match(text(), /Baixando/);
});

test('readiness offers an explicit restart/install action and never installs on mount or unmount', async () => {
  const h = bridge(downloaded);
  await mount();
  assert.match(text(), /Reiniciar e instalar/);
  assert.equal(h.calls.install, 0);
  await act(async () => button().props.onClick());
  assert.equal(h.calls.install, 1);
  assert.match(text(), /Preparando/);
  await act(async () => renderer.unmount());
  renderer = null;
  assert.equal(h.calls.install, 1);
  assert.equal(h.calls.download, 0);
});

test('shows download progress and waits for readiness before offering installation', async () => {
  const h = bridge(available);
  await mount();
  await act(async () => h.emit({ status: 'downloading', version: '9.8.7', percent: 46.4, message: 'Baixando…' }));
  assert.equal(renderer.root.findByType('progress').props.value, 46);
  assert.match(text(), /46%/);
  assert.equal(renderer.root.findAllByType('button').length, 0);
  assert.equal(h.calls.install, 0);
  await act(async () => h.emit(downloaded));
  assert.match(text(), /Reiniciar e instalar/);
  assert.equal(h.calls.install, 0);
});

test('protects a live event from a stale initial snapshot', async () => {
  const snapshot = deferred();
  const h = bridge(null, { obterStatusAtualizacao: () => snapshot.promise });
  await mount();
  await act(async () => h.emit(downloaded));
  await act(async () => snapshot.resolve(available));
  assert.match(text(), /Reiniciar e instalar/);
  assert.doesNotMatch(text(), /Baixar atualização/);
});

test('deduplicates rapid clicks while an IPC action is pending', async () => {
  const pending = deferred();
  const h = bridge(available, { baixarAtualizacao() { h.calls.download += 1; return pending.promise; } });
  await mount();
  const click = button().props.onClick;
  let first;
  let second;
  await act(async () => { first = click(); second = click(); await Promise.resolve(); });
  assert.equal(h.calls.download, 1);
  assert.equal(button().props.disabled, true);
  await act(async () => { pending.resolve({ status: 'downloading', percent: 0 }); await Promise.all([first, second]); });
  assert.equal(h.calls.download, 1);
});

for (const [retryAction, call] of [['check', 'check'], ['download', 'download'], ['install', 'install']]) {
  test(`retries ${retryAction} failures through the matching manual action`, async () => {
    const h = bridge({ status: 'error', retryAction, version: '9.8.7', message: 'Falha de atualização.', detail: 'Conexão interrompida' });
    await mount();
    assert.ok(renderer.root.findByProps({ role: 'alert' }));
    assert.match(text(), /Conexão interrompida/);
    assert.deepEqual([h.calls.check, h.calls.download, h.calls.install], [0, 0, 0]);
    await act(async () => button().props.onClick());
    assert.equal(h.calls[call], 1);
    for (const other of ['check', 'download', 'install'].filter((item) => item !== call)) assert.equal(h.calls[other], 0);
  });
}

test('a failed IPC download becomes a visible error and allows another manual download', async () => {
  const h = bridge(available, { baixarAtualizacao() { h.calls.download += 1; return Promise.reject(new Error('IPC indisponível')); } });
  await mount();
  await act(async () => button().props.onClick());
  assert.ok(renderer.root.findByProps({ role: 'alert' }));
  assert.match(text(), /IPC indisponível/);
  assert.match(text(), /Tentar baixar novamente/);
  assert.equal(button().props.disabled, false);
  assert.equal(h.calls.download, 1);
  await act(async () => button().props.onClick());
  assert.equal(h.calls.download, 2);
  assert.equal(h.calls.check, 0);
});

test('a late rejected download response cannot erase the newer ready event', async () => {
  const pending = deferred();
  const h = bridge(available, { baixarAtualizacao: () => pending.promise });
  await mount();
  let request;
  await act(async () => { request = button().props.onClick(); await Promise.resolve(); });
  await act(async () => h.emit(downloaded));
  await act(async () => { pending.reject(new Error('late IPC transport error')); await request; });
  assert.match(text(), /Reiniciar e instalar/);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('unmount removes the status listener and ignores a pending snapshot', async () => {
  const pending = deferred();
  const h = bridge(null, { obterStatusAtualizacao: () => pending.promise });
  await mount();
  assert.equal(h.listeners.size, 1);
  await act(async () => renderer.unmount());
  renderer = null;
  assert.equal(h.listeners.size, 0);
  assert.equal(h.calls.removed, 1);
  await act(async () => pending.resolve(available));
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install, 0);
});
