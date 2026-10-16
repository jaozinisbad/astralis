import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestScreenCapture, stopScreenCapture } from '../src/screenCapture.mjs';

test('screen capture lifecycle: disposing a delayed old audio request keeps the replacement native capture alive', async () => {
  const previous = Object.fromEntries(['window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const streams = [];
  function track(kind) { return { kind, stop() { this.stopped = true; } }; }
  function stream(tracks) {
    return {
      tracks,
      getTracks() { return this.tracks; },
      getAudioTracks() { return this.tracks.filter((item) => item.kind === 'audio'); },
      getVideoTracks() { return this.tracks.filter((item) => item.kind === 'video'); },
      addTrack(value) { this.tracks.push(value); },
    };
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: class {
    createMediaStreamDestination() { return { stream: stream([track('audio')]) }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    async close() {}
  } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    async getDisplayMedia() {
      const captured = stream([track('video')]);
      streams.push(captured);
      return captured;
    },
  } } });
  const nativeStarts = [];
  let stops = 0;
  const electronAPI = {
    onAudioTelaChunk: () => () => {},
    iniciarCapturaExcluindoProcesso: () => new Promise((resolve) => nativeStarts.push(resolve)),
    pararCapturaProcesso: async () => { stops += 1; },
  };
  let oldCapture;
  let replacement;
  try {
    const first = requestScreenCapture({ fonteId: 'screen:1:0', shareAudio: true }, electronAPI);
    await new Promise((resolve) => setImmediate(resolve));
    const second = requestScreenCapture({ fonteId: 'screen:1:0', shareAudio: true }, electronAPI);
    await new Promise((resolve) => setImmediate(resolve));
    nativeStarts[1]({ sucesso: true });
    replacement = await second;
    nativeStarts[0]({ sucesso: true });
    oldCapture = await first;
    await stopScreenCapture(oldCapture, electronAPI);
    assert.equal(oldCapture.getTracks().every((item) => item.stopped), true);
    assert.equal(stops, 0, 'old cleanup must not stop the native capture belonging to a newer request');
    assert.equal(replacement.getTracks().some((item) => item.stopped), false);
    await stopScreenCapture(replacement, electronAPI);
    assert.equal(stops, 1);
  } finally {
    if (oldCapture) await stopScreenCapture(oldCapture, electronAPI);
    if (replacement) await stopScreenCapture(replacement, electronAPI);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('screen capture lifecycle: an obsolete media permission grant never starts audio over the active replacement', async () => {
  const previous = Object.fromEntries(['window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  function media() {
    const video = { kind: 'video', stop() { this.stopped = true; } };
    return {
      video, tracks: [video],
      getTracks() { return this.tracks; }, getVideoTracks: () => [video],
      getAudioTracks() { return this.tracks.filter((item) => item.kind === 'audio'); },
      addTrack(value) { this.tracks.push(value); },
    };
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: class {
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ kind: 'audio', stop() {} }] } }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    async close() {}
  } } });
  let grantObsoleteMedia;
  let mediaCalls = 0;
  const replacement = media();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getDisplayMedia() {
      mediaCalls += 1;
      return mediaCalls === 1 ? new Promise((resolve) => { grantObsoleteMedia = resolve; }) : Promise.resolve(replacement);
    },
  } } });
  let starts = 0;
  let stops = 0;
  const electronAPI = {
    onAudioTelaChunk: () => () => {},
    iniciarCapturaExcluindoProcesso: async () => { starts += 1; return { sucesso: true }; },
    pararCapturaProcesso: async () => { stops += 1; },
  };
  try {
    const controller = new AbortController();
    const pending = requestScreenCapture({ fonteId: 'screen:1:0', shareAudio: true }, electronAPI, { signal: controller.signal });
    controller.abort();
    await requestScreenCapture({ fonteId: 'screen:1:0', shareAudio: true }, electronAPI);
    const obsolete = media();
    grantObsoleteMedia(obsolete);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(obsolete.video.stopped, true);
    assert.equal(starts, 1, 'a cancelled request must be discarded before it can change the native audio owner');
    assert.equal(stops, 0);
    assert.notEqual(replacement.video.stopped, true);
  } finally {
    await stopScreenCapture(replacement, electronAPI);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
