const DEFAULT_QUEUE_CAPACITY = 12_000;

export function createStereoSampleQueue(capacity = DEFAULT_QUEUE_CAPACITY) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Audio queue capacity must be a positive integer.');
  }

  const left = new Float32Array(capacity);
  const right = new Float32Array(capacity);
  let readIndex = 0;
  let writeIndex = 0;
  let size = 0;

  function pushFrame(leftSample, rightSample) {
    if (size === capacity) {
      readIndex = (readIndex + 1) % capacity;
      size -= 1;
    }
    left[writeIndex] = leftSample;
    right[writeIndex] = rightSample;
    writeIndex = (writeIndex + 1) % capacity;
    size += 1;
  }

  return {
    pushPcm16Stereo(chunk) {
      const bytes = new Uint8Array(chunk);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset + 3 < bytes.byteLength; offset += 4) {
        pushFrame(view.getInt16(offset, true) / 32768, view.getInt16(offset + 2, true) / 32768);
      }
    },

    readInto(outputLeft, outputRight) {
      if (!outputLeft || !outputRight || outputLeft.length !== outputRight.length) {
        throw new TypeError('Audio output buffers must have matching lengths.');
      }

      const count = Math.min(size, outputLeft.length);
      for (let index = 0; index < count; index += 1) {
        outputLeft[index] = left[readIndex];
        outputRight[index] = right[readIndex];
        readIndex = (readIndex + 1) % capacity;
      }
      outputLeft.fill(0, count);
      outputRight.fill(0, count);
      size -= count;
      return count;
    },

    get queuedSamples() {
      return size;
    },
  };
}