import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STREAM_QUALITY,
  STREAM_QUALITY_OPTIONS,
  getCaptureConstraints,
  getVideoEncodingParameters,
} from '../src/streamQuality.mjs';

test('stream quality: defaults stay within supported screen presets', () => {
  assert.equal(DEFAULT_STREAM_QUALITY.resolution, '720p');
  assert.equal(DEFAULT_STREAM_QUALITY.fps, 30);
  assert.equal(DEFAULT_STREAM_QUALITY.bitrate, 4_000_000);
  assert.equal(DEFAULT_STREAM_QUALITY.adaptiveQuality, true);
  assert.deepEqual(STREAM_QUALITY_OPTIONS.resolutions, ['576p', '720p', '1080p']);
  assert.deepEqual(STREAM_QUALITY_OPTIONS.fps, [15, 24, 30, 60]);
  assert.deepEqual(STREAM_QUALITY_OPTIONS.bitrates, [700_000, 2_000_000, 4_000_000, 8_000_000]);
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

test('stream quality: shares desktop audio only when enabled and Discord is not excluded', () => {
  assert.equal(getCaptureConstraints({ shareAudio: true }).audio, true);
  assert.equal(getCaptureConstraints({ shareAudio: false }).audio, false);
  assert.equal(getCaptureConstraints({ shareAudio: true, ignoreDiscordAudio: true }).audio, false);
});

test('stream quality: invalid values fall back to safe defaults', () => {
  const constraints = getCaptureConstraints({ resolution: '8k', fps: 250, shareAudio: true });
  assert.deepEqual(constraints.video.width, { ideal: 1280, max: 1280 });
  assert.deepEqual(constraints.video.height, { ideal: 720, max: 720 });
  assert.deepEqual(constraints.video.frameRate, { ideal: 30, max: 30 });
});

test('stream quality: divides adaptive bitrate budget among active viewers', () => {
  const adaptive = getVideoEncodingParameters({ bitrate: 8_000_000, adaptiveQuality: true, contentType: 'detail' }, 4);
  assert.equal(adaptive.maxBitrate, 2_000_000);
  assert.equal(adaptive.degradationPreference, 'maintain-resolution');
  const motion = getVideoEncodingParameters({ bitrate: 4_000_000, adaptiveQuality: false, contentType: 'motion' }, 4);
  assert.equal(motion.maxBitrate, 4_000_000);
  assert.equal(motion.degradationPreference, 'maintain-framerate');
});
