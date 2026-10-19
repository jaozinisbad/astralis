import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const originals = Object.fromEntries(['window', 'document', 'navigator', 'localStorage', 'CustomEvent'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let vite; let SettingsModal; let renderer; let saved; let keydown; let restoredFocus;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ default: SettingsModal } = await vite.ssrLoadModule('/src/components/SettingsModal.jsx'));
});
beforeEach(() => {
  saved = new Map(); keydown = undefined; restoredFocus = false;
  globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  globalThis.window = new EventTarget();
  globalThis.document = { activeElement: { focus() { restoredFocus = true; } }, body: { style: { overflow: 'auto' } }, documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener(type, handler) { if (type === 'keydown') keydown = handler; }, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Windows', mediaDevices: { enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: 'Microfone teste' }, { kind: 'audiooutput', deviceId: 'out-1', label: 'Fone teste' }], addEventListener() {}, removeEventListener() {} } } });
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } };
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = undefined; for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
after(async () => { await vite?.close(); });
async function render(props = {}) { await act(async () => { renderer = TestRenderer.create(React.createElement(SettingsModal, { usuario: { nome: 'Teste Astralis', email: 'teste@example.com' }, onFechar() {}, ...props })); await Promise.resolve(); }); }
const button = (label) => renderer.root.findAllByType('button').find((entry) => entry.props.children === label);
async function navigate(label) { await act(async () => button(label).props.onClick()); }

test('settings opens an accessible account view with all supported categories', async () => {
  await render();
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal'], 'true');
  assert.equal(renderer.root.findByType('h2').children[0], 'Minha conta');
  assert.equal(renderer.root.findAllByProps({ 'aria-current': 'page' }).length, 1);
  assert.equal(renderer.root.findAllByType('nav')[0].findAllByType('button').length, 13);
  assert.equal(document.body.style.overflow, 'hidden');
});
test('settings search filters categories and reports an empty result', async () => {
  await render(); const input = renderer.root.findByProps({ type: 'search' });
  await act(async () => input.props.onChange({ target: { value: 'voz' } }));
  assert.equal(renderer.root.findByType('nav').findAllByType('button').length, 1);
  await act(async () => input.props.onChange({ target: { value: 'abcdefgh' } }));
  assert.match(renderer.root.findByProps({ className: 'as-settings-search-empty' }).children[0], /Nenhuma/);
});

test('call settings opens directly at voice and video', async () => {
  await render({ initialSection: 'voice' });
  assert.equal(renderer.root.findByType('h2').children[0], 'Voz e vídeo');
});
test('appearance previews immediately and reset restores the saved theme', async () => {
  await render(); await navigate('Aparência');
  const themes = renderer.root.findAllByProps({ name: 'as-theme' });
  await act(async () => themes[1].props.onChange());
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(saved.has('astralis:interface-preferences'), false);
  await act(async () => button('Redefinir').props.onClick());
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(button('Salvar alterações'), undefined);
});
test('audio profile saves the existing audio contract and keeps settings open', async () => {
  const callbacks = []; let closed = false;
  await render({ onSalvarConfiguracao: (value) => callbacks.push(value), onFechar: () => { closed = true; } });
  await navigate('Voz e vídeo');
  const profiles = renderer.root.findAllByProps({ name: 'as-input-profile' });
  await act(async () => profiles[1].props.onChange());
  const sliders = renderer.root.findAllByProps({ type: 'range' });
  await act(async () => sliders[0].props.onChange({ target: { value: '123' } }));
  await act(async () => button('Salvar alterações').props.onClick());
  const result = JSON.parse(saved.get('configuracoesAudio'));
  assert.equal(result.volumeEntrada, 123); assert.equal(result.perfilEntrada, 'estudio'); assert.equal(result.supressaoRuido, 'desligada'); assert.equal(result.cancelamentoEco, false); assert.equal(result.ganhoAutomatico, false);
  assert.deepEqual(callbacks, [result]); assert.equal(closed, false);
  assert.match(JSON.stringify(renderer.toJSON()), /áudio do Discord fica sempre excluído/);
});
test('interface changes persist only with the save action and restore on reopen', async () => {
  await render(); await navigate('Chat');
  const toggles = renderer.root.findAllByProps({ type: 'checkbox' });
  await act(async () => toggles[0].props.onChange({ target: { checked: false } }));
  assert.equal(saved.has('astralis:interface-preferences'), false);
  await act(async () => button('Salvar alterações').props.onClick());
  assert.equal(JSON.parse(saved.get('astralis:interface-preferences')).enterToSend, false);
});
test('escape closes and unmount restores focus, scroll and an unsaved preview', async () => {
  let closed = false; await render({ onFechar: () => { closed = true; } }); await navigate('Aparência');
  await act(async () => renderer.root.findAllByProps({ name: 'as-theme' })[2].props.onChange());
  keydown({ key: 'Escape', preventDefault() {} }); assert.equal(closed, true);
  await act(async () => renderer.unmount()); renderer = undefined;
  assert.equal(document.documentElement.dataset.theme, 'dark'); assert.equal(document.body.style.overflow, 'auto'); assert.equal(restoredFocus, true);
});
test('profile and logout use the supplied application callbacks', async () => {
  let profile = 0; let logout = 0;
  await render({ onAbrirPerfil() { profile++; }, onSair() { logout++; } });
  await act(async () => button('Editar perfil de usuário').props.onClick());
  await act(async () => button('Sair da conta').props.onClick());
  await act(async () => renderer.root.findByProps({ className: 'as-settings-logout' }).props.onClick());
  assert.equal(profile, 1); assert.equal(logout, 2);
});
test('a storage failure retains unsaved changes and rolls back the audio write', async () => {
  await render(); await navigate('Aparência');
  await act(async () => renderer.root.findAllByProps({ name: 'as-theme' })[1].props.onChange());
  const originalSet = localStorage.setItem;
  localStorage.setItem = (key, value) => { if (key === 'astralis:interface-preferences') throw new Error('Storage full'); originalSet(key, value); };
  await act(async () => button('Salvar alterações').props.onClick());
  assert.equal(saved.has('configuracoesAudio'), false);
  assert.ok(button('Salvar alterações'));
  assert.match(renderer.root.findByProps({ role: 'alert' }).children[0], /Storage full/);
});
test('streamer mode removes private account and profile data from the rendered settings', async () => {
  saved.set('astralis:interface-preferences', JSON.stringify({ streamerMode: true }));
  await render({ usuario: { nome: 'Pessoa Particular', username: 'usuario_privado', email: 'privado@example.invalid', avatar_url: 'https://private.invalid/avatar.png', banner_url: 'https://private.invalid/banner.png', status: 'Status privado' } });
  for (const category of ['Minha conta', 'Perfis']) {
    await navigate(category);
    const markup = JSON.stringify(renderer.toJSON());
    for (const privateData of ['Pessoa Particular', 'usuario_privado', 'privado@example.invalid', 'private.invalid', 'Status privado']) assert.equal(markup.includes(privateData), false, `${category} leaked ${privateData}`);
    assert.match(markup, /Usuário Astralis/);
  }
});
