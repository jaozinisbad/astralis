import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVideoCodecPreferences } from '../src/streamCodecs.mjs';

const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const rtx = { mimeType: 'video/rtx', clockRate: 90000 };
const h264 = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
const red = { mimeType: 'video/red', clockRate: 90000 };
const codecs = [vp8, rtx, h264, red];
const sender = { getCapabilities: () => ({ codecs }) };

test('codec selection queries actual bounded source and promotes only efficient smooth supported profiles', async () => {
  const queries = [];
  const preferred = await resolveVideoCodecPreferences({
    sender,
    track: { getSettings: () => ({ width: 1280, height: 720 }) },
    mediaCapabilities: { async encodingInfo(query) {
      queries.push(query);
      return { supported: true, smooth: true, powerEfficient: query.video.contentType.startsWith('video/H264') };
    } },
  });
  assert.deepEqual(preferred, [h264, vp8, rtx, red]);
  assert.strictEqual(preferred[0], h264);
  assert.deepEqual(codecs, [vp8, rtx, h264, red]);
  assert.equal(queries.length, 2, 'repair codecs must not be probed as encoders');
  assert.deepEqual(queries[1], {
    type: 'webrtc',
    video: { contentType: 'video/H264;packetization-mode=1;profile-level-id=42e01f', width: 1280, height: 720, bitrate: 16_000_000, framerate: 60 },
  });
});

test('codec selection preserves browser fallback when efficient encoding is absent, unknown or fails', async () => {
  for (const result of [{ supported: true, smooth: true }, { supported: false, smooth: true, powerEfficient: true }, { supported: true, smooth: false, powerEfficient: true }]) {
    assert.deepEqual(await resolveVideoCodecPreferences({ sender, mediaCapabilities: { encodingInfo: async () => result } }), []);
  }
  assert.deepEqual(await resolveVideoCodecPreferences({ sender, mediaCapabilities: { encodingInfo: async () => { throw new Error('unsupported'); } } }), []);
  assert.deepEqual(await resolveVideoCodecPreferences({ sender: {}, mediaCapabilities: {} }), []);
  assert.deepEqual(await resolveVideoCodecPreferences({ sender: { getCapabilities() { throw new Error('unsupported'); } }, mediaCapabilities: { encodingInfo() {} } }), []);
});

test('codec selection bounds slow probes and preserves all codec profile variants and repair entries', async () => {
  const slow = { encodingInfo: () => new Promise(() => {}) };
  assert.deepEqual(await resolveVideoCodecPreferences({ sender, mediaCapabilities: slow, timeoutMs: 5 }), []);
  const high = { ...h264, sdpFmtpLine: 'packetization-mode=1;profile-level-id=64001f' };
  const result = await resolveVideoCodecPreferences({
    sender: { getCapabilities: () => ({ codecs: [...codecs, high] }) },
    track: { getSettings: () => ({ width: 3840, height: 2160 }) },
    mediaCapabilities: { async encodingInfo({ video }) {
      assert.equal(video.width, 1920);
      assert.equal(video.height, 1080);
      return { supported: true, smooth: true, powerEfficient: video.contentType.endsWith('64001f') };
    } },
  });
  assert.deepEqual(result, [high, ...codecs]);
});
