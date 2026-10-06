const CANONICAL_WEB_ORIGIN = 'https://astralis-b2w.pages.dev';

function publicHttpsOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1' || hostname === '[::1]') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildRoomInviteUrl(roomId, { accessCode, publicWebUrl, currentUrl = globalThis.location?.href } = {}) {
  if (typeof roomId !== 'string' || !roomId || /\s/u.test(roomId)) {
    throw new TypeError('A valid room ID is required.');
  }

  const origin = publicHttpsOrigin(publicWebUrl)
    || publicHttpsOrigin(currentUrl)
    || CANONICAL_WEB_ORIGIN;
  const url = new URL(origin);
  url.searchParams.set('room', roomId);
  if (typeof accessCode === 'string' && accessCode.trim()) {
    url.searchParams.set('code', accessCode.trim());
  }
  return url.toString();
}

export async function copyRoomInviteUrl(roomId, options = {}) {
  const url = buildRoomInviteUrl(roomId, options);
  const electronAPI = options.electronAPI === undefined ? globalThis.window?.electronAPI : options.electronAPI;
  const clipboard = options.clipboard === undefined ? globalThis.navigator?.clipboard : options.clipboard;

  if (typeof electronAPI?.copiarTexto === 'function') {
    try {
      await electronAPI.copiarTexto(url);
      return url;
    } catch {
      // Browser clipboard may still be available if native copy fails.
    }
  }
  if (typeof clipboard?.writeText === 'function') {
    await clipboard.writeText(url);
    return url;
  }
  throw new Error('Clipboard access is unavailable.');
}
