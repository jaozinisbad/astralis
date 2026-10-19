import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { applyInterfacePreferences, INTERFACE_DEFAULTS, INTERFACE_SETTINGS_EVENT, INTERFACE_STORAGE_KEY, loadInterfacePreferences, normalizeInterfacePreferences, saveInterfacePreferences } from './interfacePreferences.mjs';

const originals = Object.fromEntries(['window', 'document', 'localStorage', 'CustomEvent'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let saved; let properties;
beforeEach(() => {
  saved = new Map(); properties = new Map();
  globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  globalThis.window = new EventTarget();
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } } };
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } };
});
afterEach(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

test('interface defaults preserve readable chat and disable notifications until opted in', () => {
  assert.deepEqual(loadInterfacePreferences(), INTERFACE_DEFAULTS);
  assert.equal(loadInterfacePreferences().showAvatars, true);
  assert.equal(loadInterfacePreferences().desktopNotifications, false);
  assert.equal(loadInterfacePreferences().notificationSound, false);
});
test('stored malformed values cannot inject dataset or unexpected preferences', () => {
  saved.set(INTERFACE_STORAGE_KEY, '{invalid');
  assert.deepEqual(loadInterfacePreferences(), INTERFACE_DEFAULTS);
  assert.deepEqual(normalizeInterfacePreferences(null), INTERFACE_DEFAULTS);
  const sanitized = normalizeInterfacePreferences({ theme: 'invented', density: 'tiny', highContrast: 'false', fontSize: 200, untrusted: true });
  assert.equal(sanitized.theme, 'dark'); assert.equal(sanitized.density, 'default'); assert.equal(sanitized.highContrast, false); assert.equal(sanitized.fontSize, 20); assert.equal('untrusted' in sanitized, false);
  assert.equal(normalizeInterfacePreferences({ fontSize: null }).fontSize, 16);
});
test('saving persists normalized settings, applies datasets and notifies subscribers', () => {
  let detail; window.addEventListener(INTERFACE_SETTINGS_EVENT, (event) => { detail = event.detail; });
  const result = saveInterfacePreferences({ ...INTERFACE_DEFAULTS, theme: 'light', density: 'compact', fontSize: 18, reducedMotion: true, showAvatars: false });
  assert.deepEqual(JSON.parse(saved.get(INTERFACE_STORAGE_KEY)), result);
  assert.deepEqual(detail, result);
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.dataset.density, 'compact');
  assert.equal(document.documentElement.dataset.showAvatars, 'false');
  assert.equal(document.documentElement.dataset.reducedMotion, 'true');
  assert.equal(properties.get('--as-font-size'), '18px');
});
test('preview application does not persist or emit a settings event', () => {
  let events = 0; window.addEventListener(INTERFACE_SETTINGS_EVENT, () => { events++; });
  applyInterfacePreferences({ ...INTERFACE_DEFAULTS, theme: 'midnight' });
  assert.equal(document.documentElement.dataset.theme, 'midnight'); assert.equal(saved.size, 0); assert.equal(events, 0);
});
test('storage failure remains visible to the caller and does not apply unsaved values', () => {
  localStorage.setItem = () => { throw new Error('Storage full'); };
  assert.throws(() => saveInterfacePreferences({ ...INTERFACE_DEFAULTS, theme: 'light' }), /Storage full/);
  assert.equal(document.documentElement.dataset.theme, undefined);
});
