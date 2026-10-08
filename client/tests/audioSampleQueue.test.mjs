import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStereoSampleQueue } from '../src/audioSampleQueue.mjs';

function pcm16Stereo(frames) {
  const chunk = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], index) => {
    chunk.writeInt16LE(left, index * 4);
    chunk.writeInt16LE(right, index * 4 + 2);
  });
  return chunk;
}

test('stereo sample queue preserves frame order and fills underruns with silence', () => {
  const queue = createStereoSampleQueue(4);
  queue.pushPcm16Stereo(pcm16Stereo([[16384, -16384], [8192, -8192]]));
  const left = new Float32Array(3);
  const right = new Float32Array(3);

  assert.equal(queue.readInto(left, right), 2);
  assert.deepEqual([...left], [0.5, 0.25, 0]);
  assert.deepEqual([...right], [-0.5, -0.25, 0]);
  assert.equal(queue.queuedSamples, 0);
});

test('stereo sample queue drops stale frames when it reaches its latency bound', () => {
  const queue = createStereoSampleQueue(2);
  queue.pushPcm16Stereo(pcm16Stereo([[1000, -1000], [2000, -2000], [3000, -3000]]));
  const left = new Float32Array(2);
  const right = new Float32Array(2);

  assert.equal(queue.queuedSamples, 2);
  assert.equal(queue.readInto(left, right), 2);
  assert.ok(Math.abs(left[0] - 2000 / 32768) < 1e-7);
  assert.ok(Math.abs(left[1] - 3000 / 32768) < 1e-7);
  assert.ok(Math.abs(right[0] + 2000 / 32768) < 1e-7);
  assert.ok(Math.abs(right[1] + 3000 / 32768) < 1e-7);
});
