export const DEFAULT_STREAM_QUALITY = Object.freeze({
  resolution: '1080p',
  fps: 60,
  bitrate: 16_000_000,
  adaptiveQuality: false,
  contentType: 'detail',
  shareAudio: true,
  ignoreDiscordAudio: false,
});

export const STREAM_QUALITY_OPTIONS = Object.freeze({
  resolutions: Object.freeze(['576p', '720p', '1080p']),
  fps: Object.freeze([15, 24, 30, 60]),
  bitrates: Object.freeze([700_000, 2_000_000, 4_000_000, 8_000_000, 16_000_000]),
});

const DIMENSIONS = Object.freeze({
  '576p': Object.freeze({ width: 1024, height: 576 }),
  '720p': Object.freeze({ width: 1280, height: 720 }),
  '1080p': Object.freeze({ width: 1920, height: 1080 }),
});

export function resolveStreamQuality(settings = {}) {
  const requestedResolution = settings.resolution ?? settings.resolucao;
  const resolution = STREAM_QUALITY_OPTIONS.resolutions.includes(requestedResolution)
    ? requestedResolution
    : DEFAULT_STREAM_QUALITY.resolution;
  const fps = STREAM_QUALITY_OPTIONS.fps.includes(Number(settings.fps))
    ? Number(settings.fps)
    : DEFAULT_STREAM_QUALITY.fps;
  const bitrate = STREAM_QUALITY_OPTIONS.bitrates.includes(Number(settings.bitrate))
    ? Number(settings.bitrate)
    : DEFAULT_STREAM_QUALITY.bitrate;

  return {
    ...DEFAULT_STREAM_QUALITY,
    ...settings,
    resolution,
    fps,
    bitrate,
    contentType: settings.contentType === 'motion' ? 'motion' : 'detail',
    adaptiveQuality: settings.adaptiveQuality === undefined
      ? DEFAULT_STREAM_QUALITY.adaptiveQuality
      : Boolean(settings.adaptiveQuality),
  };
}

export function getCaptureConstraints(settings = {}) {
  const resolved = resolveStreamQuality(settings);
  const { width, height } = DIMENSIONS[resolved.resolution];

  return {
    video: {
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
      frameRate: { ideal: resolved.fps, max: resolved.fps },
    },
    audio: Boolean(resolved.shareAudio && !resolved.ignoreDiscordAudio),
  };
}

export function getVideoEncodingParameters(settings = {}, viewerCount = 1) {
  const resolved = resolveStreamQuality(settings);
  const viewers = Math.max(1, Math.floor(Number(viewerCount) || 1));
  const maxBitrate = resolved.adaptiveQuality
    ? Math.max(250_000, Math.floor(resolved.bitrate / viewers))
    : resolved.bitrate;

  return {
    maxBitrate,
    degradationPreference: resolved.contentType === 'motion'
      ? 'maintain-framerate'
      : 'maintain-resolution',
  };
}
