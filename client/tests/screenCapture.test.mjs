import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestScreenCapture, stopScreenCapture } from '../src/screenCapture.mjs';

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
}

test('screen capture: applies selected source and excludes Discord audio on Electron', async () => {
  const videoTrack = { kind: 'video', stop() { this.stopped = true; } };
  const filteredAudio = { kind: 'audio', stop() { this.stopped = true; } };
  const displayOptions = [];
  let selectedSource;
  let stoppedProcessCapture = false;
  const audioContext = {
    destination: { stream: new FakeStream([filteredAudio]) },
    createMediaStreamDestination() { return this.destination; },
    createScriptProcessor() { return { connect() {}, disconnect() {} }; },
    close: async () => {},
  };
  const previous = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    MediaStream: Object.getOwnPropertyDescriptor(globalThis, 'MediaStream'),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async (options) => { displayOptions.push(options); return new FakeStream([videoTrack]); } } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: function AudioContext() { return audioContext; } } });
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: FakeStream });
  const electronAPI = {
    definirFonteCompartilhamento: (id) => { selectedSource = id; },
    iniciarCapturaExcluindoProcesso: async (name) => ({ sucesso: name === 'Discord.exe' }),
    onAudioTelaChunk: () => () => {},
    pararCapturaProcesso: async () => { stoppedProcessCapture = true; },
  };
  try {
    const stream = await requestScreenCapture({ fonteId: 'screen:9', resolution: '1080p', fps: 60, shareAudio: true, ignoreDiscordAudio: true }, electronAPI);
    assert.equal(selectedSource, 'screen:9');
    assert.equal(displayOptions[0].audio, false);
    assert.equal(displayOptions[0].video.frameRate.max, 60);
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video', 'audio']);
    await stopScreenCapture(stream, electronAPI);
    assert.equal(videoTrack.stopped, true);
    assert.equal(filteredAudio.stopped, true);
    assert.equal(stoppedProcessCapture, true);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('screen capture: shares desktop audio only when enabled and Discord filtering is available', async () => {
  const options = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async (value) => { options.push(value); return new FakeStream([]); } } } });
  try {
    await requestScreenCapture({ shareAudio: false });
    await requestScreenCapture({ shareAudio: true, ignoreDiscordAudio: true });
    await requestScreenCapture({ shareAudio: true });
    assert.deepEqual(options.map((option) => option.audio), [false, false, true]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});
