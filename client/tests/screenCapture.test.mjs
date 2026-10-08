import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScreenCaptureWarning, requestScreenCapture, stopScreenCapture } from '../src/screenCapture.mjs';
import { findSelectedCaptureSource, getWindowHandleFromSourceId, shouldUseSystemLoopback } from '../electron/screenCapturePolicy.cjs';

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}

test('screen capture: default profile requests full HD at 30 fps with motion hint', async () => {
  const videoTrack = { kind: 'video', contentHint: '', stop() {} };
  const options = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async (value) => { options.push(value); return new FakeStream([videoTrack]); } } },
  });
  try {
    const stream = await requestScreenCapture();
    assert.deepEqual(options[0].video, {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    });
    assert.equal(videoTrack.contentHint, 'motion');
    await stopScreenCapture(stream);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

test('screen capture: detail profile keeps the detail hint', async () => {
  const videoTrack = { kind: 'video', contentHint: '', stop() {} };
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async () => new FakeStream([videoTrack]) } },
  });
  try {
    const stream = await requestScreenCapture({ contentType: 'detail' });
    assert.equal(videoTrack.contentHint, 'detail');
    await stopScreenCapture(stream);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

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

test('screen capture: a selected Electron window uses only that window process audio', async () => {
  const videoTrack = { kind: 'video', stop() {} };
  const filteredAudio = { kind: 'audio', stop() {} };
  const audioContext = {
    destination: { stream: new FakeStream([filteredAudio]) },
    createMediaStreamDestination() { return this.destination; },
    createScriptProcessor() { return { connect() {}, disconnect() {} }; },
    close: async () => {},
  };
  const calls = { display: 0, window: null, process: null, exclusion: 0 };
  const previous = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getDisplayMedia: async () => { calls.display += 1; return new FakeStream([videoTrack]); },
      getUserMedia: async (constraints) => { calls.window = constraints; return new FakeStream([videoTrack]); },
    } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: function AudioContext() { return audioContext; } } });
  const electronAPI = {
    iniciarCapturaAudioJanela: async (sourceId) => { calls.process = sourceId; return { sucesso: true }; },
    iniciarCapturaExcluindoProcesso: async () => { calls.exclusion += 1; return { sucesso: true }; },
    onAudioTelaChunk: () => () => {},
    pararCapturaProcesso: async () => {},
  };
  try {
    const stream = await requestScreenCapture({
      fonteId: 'window:45678:0', modoCaptura: 'compatibilidade', shareAudio: true, ignoreDiscordAudio: true,
      resolution: '720p', fps: 30,
    }, electronAPI);
    assert.equal(calls.display, 0);
    assert.equal(calls.window.video.mandatory.chromeMediaSource, 'desktop');
    assert.equal(calls.window.video.mandatory.chromeMediaSourceId, 'window:45678:0');
    assert.equal(calls.process, 'window:45678:0');
    assert.equal(calls.exclusion, 0);
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video', 'audio']);
    assert.equal(getScreenCaptureWarning(stream), '');
    await stopScreenCapture(stream, electronAPI);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('screen capture: a window process audio failure stays video-only and exposes a warning', async () => {
  const videoTrack = { kind: 'video', stop() {} };
  let displayRequested = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getDisplayMedia: async () => { displayRequested = true; return new FakeStream([videoTrack]); },
      getUserMedia: async () => new FakeStream([videoTrack]),
    } },
  });
  const electronAPI = { iniciarCapturaAudioJanela: async () => ({ sucesso: false }) };
  try {
    const stream = await requestScreenCapture({ fonteId: 'window:45678:0', modoCaptura: 'compatibilidade', shareAudio: true }, electronAPI);
    assert.equal(displayRequested, false);
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video']);
    assert.match(getScreenCaptureWarning(stream), /áudio.*janela/i);
    await stopScreenCapture(stream, electronAPI);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('screen capture policy: only a currently selected monitor can request system loopback', () => {
  const screen = { id: 'screen:1:0', name: 'Monitor 1' };
  const window = { id: 'window:45678:0', name: 'Jogo' };
  assert.equal(findSelectedCaptureSource([screen, window], window.id), window);
  assert.equal(findSelectedCaptureSource([screen, window], 'window:99999:0'), null);
  assert.equal(getWindowHandleFromSourceId(window.id), '45678');
  assert.equal(getWindowHandleFromSourceId('screen:1:0'), null);
  assert.equal(getWindowHandleFromSourceId('window:not-a-hwnd:0'), null);
  assert.equal(shouldUseSystemLoopback({ audioRequested: true }, screen), true);
  assert.equal(shouldUseSystemLoopback({ audioRequested: false }, screen), false);
  assert.equal(shouldUseSystemLoopback({ audioRequested: true }, window), false);
  assert.equal(shouldUseSystemLoopback({ audioRequested: true }, null), false);
});
test('screen capture: browser-selected window audio is removed instead of being sent as system audio', async () => {
  const videoTrack = { kind: 'video', getSettings: () => ({ displaySurface: 'window' }), stop() {} };
  const audioTrack = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async () => new FakeStream([videoTrack, audioTrack]) } },
  });
  try {
    const stream = await requestScreenCapture({ shareAudio: true }, null);
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video']);
    assert.equal(audioTrack.stopped, true);
    assert.match(getScreenCaptureWarning(stream), /áudio foi removido/i);
    await stopScreenCapture(stream, null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('screen capture: an explicitly selected Electron monitor can keep requested system audio', async () => {
  const videoTrack = { kind: 'video', getSettings: () => ({}), stop() {} };
  const audioTrack = { kind: 'audio', stop() {} };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async (options) => {
      assert.equal(options.audio, true);
      return new FakeStream([videoTrack, audioTrack]);
    } } },
  });
  let selectedSource = null;
  const electronAPI = { definirFonteCompartilhamento: (sourceId) => { selectedSource = sourceId; } };
  try {
    const stream = await requestScreenCapture({ fonteId: 'screen:1:0', shareAudio: true }, electronAPI);
    assert.equal(selectedSource, 'screen:1:0');
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video', 'audio']);
    await stopScreenCapture(stream, electronAPI);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});
test('screen capture: disabling audio keeps a selected window video-only', async () => {
  const videoTrack = { kind: 'video', stop() {} };
  const unexpectedAudio = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => new FakeStream([videoTrack, unexpectedAudio]) } },
  });
  try {
    const stream = await requestScreenCapture({
      fonteId: 'window:45678:0', modoCaptura: 'compatibilidade', shareAudio: false,
    }, {});
    assert.deepEqual(stream.getTracks().map((track) => track.kind), ['video']);
    assert.equal(unexpectedAudio.stopped, true);
    await stopScreenCapture(stream, {});
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});
