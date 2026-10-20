import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite, useFriends, renderer, state, responses, calls;
const originalFetch = globalThis.fetch;
const pending = { recebidos: [{ id: 8, usuario: { id: 2, nome: 'Vega' } }], enviados: [] };
const friends = [{ id: 2, nome: 'Vega', online: true }];
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ useFriends } = await vite.ssrLoadModule('/src/useFriends.mjs'));
});
after(async () => vite?.close());
beforeEach(() => {
  responses = []; calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, ...options });
    const entry = responses.shift();
    if (entry instanceof Promise) return entry;
    return { ok: !entry?.erro, status: entry?.erro ? 500 : 200, json: async () => entry };
  };
});
afterEach(() => { act(() => renderer?.unmount()); renderer = null; globalThis.fetch = originalFetch; });
function Probe({ token = 'local', socket }) { state = useFriends(token, socket); return null; }
async function mount(props = {}) { await act(async () => { renderer = TestRenderer.create(React.createElement(Probe, props)); }); }

test('friend and request lists load separately; acceptance refreshes both through the real API adapter', async () => {
  responses.push([], pending);
  await mount();
  assert.deepEqual(state.amigos, []);
  assert.equal(state.pedidos.recebidos[0].id, 8);
  responses.push({ mensagem: 'Aceito' }, friends, { recebidos: [], enviados: [] });
  await act(async () => state.aceitar(8));
  assert.equal(calls[2].path, '/api/amigos/pedidos/8/aceitar');
  assert.equal(calls[2].method, 'POST');
  assert.equal(state.amigos[0].nome, 'Vega');
  assert.equal(state.pedidos.recebidos.length, 0);
});

test('load error stays visible and retry succeeds without inventing accepted friends', async () => {
  responses.push({ erro: 'API indisponível' }, pending);
  await mount();
  assert.equal(state.erro, 'API indisponível');
  assert.deepEqual(state.amigos, []);
  responses.push(friends, { recebidos: [], enviados: [] });
  await act(async () => state.refresh());
  assert.equal(state.erro, '');
  assert.equal(state.amigos.length, 1);
});

test('logout cannot be overwritten by a late response from the previous account', async () => {
  let resolve;
  responses.push(new Promise(done => { resolve = done; }), pending);
  await mount();
  await act(async () => renderer.update(React.createElement(Probe, { token: null })));
  await act(async () => { resolve({ ok: true, status: 200, json: async () => friends }); await Promise.resolve(); });
  assert.deepEqual(state.amigos, []);
  assert.deepEqual(state.pedidos, { recebidos: [], enviados: [] });
  assert.equal(state.carregando, false);
});
