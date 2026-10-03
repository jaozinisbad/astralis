import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STREAM_QUALITY,
  STREAM_QUALITY_OPTIONS,
  getCaptureConstraints,
  getVideoEncodingParameters,
  resolveStreamQuality,
} from '../src/streamQuality.mjs';

test('stream quality: default capture requests full HD at 60 fps and permits 16 Mbps per viewer', () => {
  const constraints = getCaptureConstraints();
  const encoding = getVideoEncodingParameters({}, 3);

  assert.deepEqual(constraints.video.width, { ideal: 1920, max: 1920 });
  assert.deepEqual(constraints.video.height, { ideal: 1080, max: 1080 });
  assert.deepEqual(constraints.video.frameRate, { ideal: 60, max: 60 });
  assert.equal(encoding.maxBitrate, 16_000_000);
  assert.ok(STREAM_QUALITY_OPTIONS.bitrates.includes(16_000_000));
  assert.equal(DEFAULT_STREAM_QUALITY.resolution, '1080p');
  assert.equal(DEFAULT_STREAM_QUALITY.fps, 60);
  assert.equal(DEFAULT_STREAM_QUALITY.bitrate, 16_000_000);
  assert.equal(DEFAULT_STREAM_QUALITY.adaptiveQuality, false);
});

test('stream quality: maps all supported resolutions and frame rates to capture constraints', () => {
  const expected = {
    '576p': [1024, 576],
    '720p': [1280, 720],
    '1080p': [1920, 1080],
  };
  for (const [resolution, [width, height]] of Object.entries(expected)) {
    for (const fps of STREAM_QUALITY_OPTIONS.fps) {
      const constraints = getCaptureConstraints({ resolution, fps, shareAudio: false });
      assert.deepEqual(constraints.video.width, { ideal: width, max: width });
      assert.deepEqual(constraints.video.height, { ideal: height, max: height });
      assert.deepEqual(constraints.video.frameRate, { ideal: fps, max: fps });
      assert.equal(constraints.audio, false);
    }
  }
});

test('stream quality: resolves the legacy resolution key used by channel sharing', () => {
  const quality = resolveStreamQuality({ resolucao: '720p', fps: 24, bitrate: 8_000_000 });
  assert.equal(quality.resolution, '720p');
  assert.equal(quality.fps, 24);
  assert.equal(quality.bitrate, 8_000_000);
  assert.deepEqual(getCaptureConstraints({ resolucao: '720p', fps: 24 }).video, {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 24 },
  });
});

test('stream quality: shares desktop audio only when enabled and Discord is not excluded', () => {
  assert.equal(getCaptureConstraints({ shareAudio: true }).audio, true);
  assert.equal(getCaptureConstraints({ shareAudio: false }).audio, false);
  assert.equal(getCaptureConstraints({ shareAudio: true, ignoreDiscordAudio: true }).audio, false);
});

test('stream quality: invalid values fall back to safe defaults', () => {
  const constraints = getCaptureConstraints({ resolution: '8k', fps: 250, shareAudio: true });
  assert.deepEqual(constraints.video.width, { ideal: 1920, max: 1920 });
  assert.deepEqual(constraints.video.height, { ideal: 1080, max: 1080 });
  assert.deepEqual(constraints.video.frameRate, { ideal: 60, max: 60 });
});

test('stream quality: divides adaptive bitrate budget among active viewers', () => {
  const adaptive = getVideoEncodingParameters({ bitrate: 8_000_000, adaptiveQuality: true, contentType: 'detail' }, 4);
  assert.equal(adaptive.maxBitrate, 2_000_000);
  assert.equal(adaptive.degradationPreference, 'maintain-resolution');
  const motion = getVideoEncodingParameters({ bitrate: 4_000_000, adaptiveQuality: false, contentType: 'motion' }, 4);
  assert.equal(motion.maxBitrate, 4_000_000);
  assert.equal(motion.degradationPreference, 'maintain-framerate');
  assert.equal(getVideoEncodingParameters({ bitrate: 16_000_000, adaptiveQuality: true }, 4).maxBitrate, 4_000_000);
});
