import { getCaptureConstraints, resolveStreamQuality } from './streamQuality.mjs';

const REPAIR_CODECS = new Set(['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']);

/** Prefer a measured efficient encoder, without removing interoperable fallbacks. */
export async function resolveVideoCodecPreferences({
  quality = {},
  track,
  sender = globalThis.RTCRtpSender,
  mediaCapabilities = globalThis.navigator?.mediaCapabilities,
  timeoutMs = 800,
} = {}) {
  if (typeof sender?.getCapabilities !== 'function'
    || typeof mediaCapabilities?.encodingInfo !== 'function') return [];
  let codecs;
  let source;
  try {
    codecs = sender.getCapabilities('video')?.codecs;
    source = track?.getSettings?.() || {};
  } catch { return []; }
  if (!Array.isArray(codecs) || !codecs.length) return [];

  const profile = resolveStreamQuality(quality);
  const { video } = getCaptureConstraints(profile);
  const dimension = (actual, ceiling) => Number.isFinite(actual) && actual > 0
    ? Math.min(Math.floor(actual), ceiling) : ceiling;
  const width = dimension(source.width, video.width.max);
  const height = dimension(source.height, video.height.max);
  const candidates = codecs.filter((codec) => typeof codec.mimeType === 'string'
    && codec.mimeType.toLowerCase().startsWith('video/')
    && !REPAIR_CODECS.has(codec.mimeType.toLowerCase()));
  if (!candidates.length) return [];

  let timer;
  try {
    // Bound startup even if a browser/driver never settles its capability query.
    const results = await Promise.race([
      Promise.all(candidates.map(async (codec) => {
        try {
          const contentType = codec.mimeType + (codec.sdpFmtpLine ? `;${codec.sdpFmtpLine}` : '');
          const info = await mediaCapabilities.encodingInfo({
            type: 'webrtc',
            video: { contentType, width, height, bitrate: profile.bitrate, framerate: profile.fps },
          });
          return info?.supported === true && info.smooth === true && info.powerEfficient === true;
        } catch { return false; }
      })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!results) return [];
    const preferred = new Set(candidates.filter((codec, index) => results[index]));
    if (!preferred.size) return [];
    // Keep the exact codec objects, profile parameters and RTX/RED/FEC entries.
    // The receiver can still negotiate another supported codec.
    return [...codecs.filter((codec) => preferred.has(codec)), ...codecs.filter((codec) => !preferred.has(codec))];
  } finally {
    clearTimeout(timer);
  }
}
