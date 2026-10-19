import { useCallback, useEffect, useState } from 'react';

export const INTERFACE_STORAGE_KEY = 'astralis:interface-preferences';
export const INTERFACE_SETTINGS_EVENT = 'astralis:interface-settings';
export const INTERFACE_DEFAULTS = Object.freeze({
  theme: 'dark',
  density: 'default',
  fontSize: 16,
  reducedMotion: false,
  highContrast: false,
  showAvatars: true,
  showTimestamps: true,
  enterToSend: true,
  mediaPreviews: true,
  desktopNotifications: false,
  notificationSound: false,
  streamerMode: false,
  developerMode: false,
});

export function normalizeInterfacePreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { ...INTERFACE_DEFAULTS };
  if (['dark', 'light', 'midnight'].includes(source.theme)) result.theme = source.theme;
  if (['default', 'compact', 'spacious'].includes(source.density)) result.density = source.density;
  if (typeof source.fontSize === 'number' && Number.isFinite(source.fontSize)) result.fontSize = Math.min(20, Math.max(14, source.fontSize));
  for (const key of Object.keys(INTERFACE_DEFAULTS)) {
    if (typeof INTERFACE_DEFAULTS[key] === 'boolean' && typeof source[key] === 'boolean') result[key] = source[key];
  }
  return result;
}

export function loadInterfacePreferences() {
  try {
    return normalizeInterfacePreferences(JSON.parse(globalThis.localStorage?.getItem(INTERFACE_STORAGE_KEY) || '{}'));
  } catch {
    return { ...INTERFACE_DEFAULTS };
  }
}

export function applyInterfacePreferences(value) {
  const prefs = normalizeInterfacePreferences(value);
  const root = globalThis.document?.documentElement;
  if (!root) return prefs;
  for (const key of ['theme', 'density', 'highContrast', 'reducedMotion', 'showAvatars', 'showTimestamps', 'mediaPreviews', 'streamerMode', 'developerMode']) {
    root.dataset[key] = String(prefs[key]);
  }
  root.style.setProperty('--as-font-size', `${prefs.fontSize}px`);
  return prefs;
}

export function saveInterfacePreferences(value) {
  const prefs = normalizeInterfacePreferences(value);
  // Let callers surface a storage failure instead of claiming a preference was saved.
  globalThis.localStorage?.setItem(INTERFACE_STORAGE_KEY, JSON.stringify(prefs));
  applyInterfacePreferences(prefs);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(INTERFACE_SETTINGS_EVENT, { detail: prefs }));
  }
  return prefs;
}

export function useInterfacePreferences() {
  const [preferences, setPreferences] = useState(loadInterfacePreferences);
  useEffect(() => {
    const refresh = (event) => {
      if (event?.type === 'storage' && event.key !== null && event.key !== INTERFACE_STORAGE_KEY) return;
      const latest = loadInterfacePreferences();
      applyInterfacePreferences(latest);
      setPreferences(latest);
    };
    applyInterfacePreferences(loadInterfacePreferences());
    window.addEventListener(INTERFACE_SETTINGS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(INTERFACE_SETTINGS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const updatePreferences = useCallback((value) => {
    const current = loadInterfacePreferences();
    const next = saveInterfacePreferences(typeof value === 'function' ? value(current) : value);
    setPreferences(next);
  }, []);
  return [preferences, updatePreferences];
}
