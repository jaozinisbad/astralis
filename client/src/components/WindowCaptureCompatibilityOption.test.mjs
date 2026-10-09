import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const originalWindow = globalThis.window;
let vite;
let WindowCaptureCompatibilityOption;
let renderer;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ default: WindowCaptureCompatibilityOption } = await vite.ssrLoadModule('/src/components/WindowCaptureCompatibilityOption.jsx'));
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

after(async () => { await vite?.close(); });

async function renderOption(api) {
  globalThis.window = { electronAPI: api };
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(WindowCaptureCompatibilityOption, { visible: true }));
    await Promise.resolve();
  });
}

test('applies the opt-in only after the explicit restart action', async () => {
  const applied = [];
  await renderOption({
    obterCompatibilidadeCapturaJanela: async () => ({ available: true, enabled: false }),
    aplicarCompatibilidadeCapturaJanela: async (enabled) => { applied.push(enabled); return { ok: true, alterada: true }; },
  });
  const checkbox = renderer.root.findByType('input');
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const button = renderer.root.findByType('button');
  await act(async () => { await button.props.onClick(); });
  assert.deepEqual(applied, [true]);
  assert.match(renderer.root.findByType('button').props.children, /Reiniciando/);
});

test('shows a recoverable error if persisting the option fails', async () => {
  await renderOption({
    obterCompatibilidadeCapturaJanela: async () => ({ available: true, enabled: false }),
    aplicarCompatibilidadeCapturaJanela: async () => ({ ok: false, mensagem: 'Falha de teste' }),
  });
  const checkbox = renderer.root.findByType('input');
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  await act(async () => { await renderer.root.findByType('button').props.onClick(); });
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children[0], 'Falha de teste');
  assert.equal(renderer.root.findByType('button').props.disabled, false);
});

test('hides the option when the Windows 10 compatibility backend is unavailable', async () => {
  await renderOption({
    obterCompatibilidadeCapturaJanela: async () => ({ available: false, enabled: false }),
  });
  assert.equal(renderer.toJSON(), null);
});
