const { createHmac } = require('node:crypto');

const DEFAULT_STUN = { urls: 'stun:stun.l.google.com:19302' };
const TURN_CREDENTIAL_TTL_SECONDS = 3600;

function createRoomIceConfiguration({ env = process.env, socketId = '', now = Date.now() } = {}) {
  const iceServers = [{ ...DEFAULT_STUN }];
  const urls = (env.WEBRTC_TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const secret = env.WEBRTC_TURN_SECRET;
  if (!secret || !urls.length || urls.length > 8
    || urls.some((url) => !/^turns?:[a-z\d.\[\]:-]+(?:\?transport=(?:udp|tcp))?$/i.test(url))) {
    return { iceServers, expiresAt: now + 300_000 };
  }

  const expiresAtSeconds = Math.floor(now / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAtSeconds}:${String(socketId).replace(/[^a-z\d_-]/gi, '').slice(0, 128)}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  iceServers.push({ urls, username, credential });
  return { iceServers, expiresAt: expiresAtSeconds * 1000 };
}

module.exports = { createRoomIceConfiguration };
