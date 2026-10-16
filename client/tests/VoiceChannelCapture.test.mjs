import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite;
let VoiceChannel;
before(async () => {
  vite = await createServer({
    configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } }, appType: 'custom',
  });
  ({ default: VoiceChannel } = await vite.ssrLoadModule('/src/components/VoiceChannel.jsx'));
});
after(async () => { await vite?.close(); });

test('legacy voice sharing uses protected 60 fps capture and releases its tracks on channel exit', async () => {
  const previous = Object.fromEntries(['window', 'navigator', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const video = { kind: 'video', getSettings: () => ({ height: 1080 }), stop() { this.stopped = true; } };
  const unexpectedAudio = { kind: 'audio', stop() { this.stopped = true; } };
  const stream = {
    tracks: [video, unexpectedAudio],
    getTracks() { return this.tracks; },
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); },
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); },
    removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); },
  };
  const options = [];
  const values = {
    window: {}, document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null },
    navigator: { mediaDevices: {
      getUserMedia: async () => { throw Object.assign(new Error('No microphone in capture test'), { name: 'NotFoundError' }); },
      getDisplayMedia: async (value) => { options.push(value); return stream; },
    } },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let renderer;
  try {
    const ref = React.createRef();
    const states = [];
    const socket = { id: 'self', on() {}, off() {}, emit() {} };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(VoiceChannel, {
        ref, canal: { id: 'voice', nome: 'Voz' }, socket,
        onEstadoChange: (state) => states.push(state),
      }));
    });
    await act(async () => ref.current.iniciarCompartilhamento({ fps: 30, ignoreDiscordAudio: false, shareAudio: true }));
    assert.equal(options.length, 1);
    assert.equal(options[0].audio, false);
    assert.deepEqual(options[0].video.frameRate, { ideal: 60, max: 60 });
    assert.deepEqual(options[0].video.width, { ideal: 1920, max: 1920 });
    assert.equal(unexpectedAudio.stopped, true);
    assert.equal(stream.getAudioTracks().length, 0);
    assert.equal(states.at(-1).compartilhandoTela, true);
    await act(async () => renderer.unmount());
    renderer = null;
    assert.equal(video.stopped, true);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('legacy voice sharing closes capture that is granted after the channel unmounts', async () => {
  const previous = Object.fromEntries(['window', 'navigator', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const video = { kind: 'video', getSettings: () => ({ height: 1080 }), stop() { this.stopped = true; } };
  const stream = {
    getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => [],
  };
  let grantCapture;
  const values = {
    window: {}, document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null },
    navigator: { mediaDevices: {
      getUserMedia: async () => { throw Object.assign(new Error('No microphone in capture test'), { name: 'NotFoundError' }); },
      getDisplayMedia: () => new Promise((resolve) => { grantCapture = resolve; }),
    } },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let renderer;
  try {
    const ref = React.createRef();
    const socket = { id: 'self', on() {}, off() {}, emit() {} };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(VoiceChannel, {
        ref, canal: { id: 'voice', nome: 'Voz' }, socket,
      }));
    });
    let pendingCapture;
    await act(async () => {
      pendingCapture = ref.current.iniciarCompartilhamento({ shareAudio: false });
    });
    assert.equal(typeof grantCapture, 'function');
    await act(async () => renderer.unmount());
    renderer = null;
    await act(async () => {
      grantCapture(stream);
      await pendingCapture;
    });
    assert.equal(video.stopped, true, 'a capture granted after leaving must not remain active invisibly');
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('voice preview keeps its MediaStream attached across unrelated renders', async () => {
  const previous = Object.fromEntries(['window', 'navigator', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const track = { kind: 'video', getSettings: () => ({ height: 1080 }), stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  const values = {
    window: {}, document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null },
    navigator: { mediaDevices: {
      getUserMedia: async () => { throw Object.assign(new Error('No microphone in preview test'), { name: 'NotFoundError' }); },
    } },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const assignments = [];
  let attachedStream = null;
  const videoElement = {};
  Object.defineProperty(videoElement, 'srcObject', {
    get: () => attachedStream,
    set(value) { attachedStream = value; assignments.push(value); },
  });
  let renderer;
  try {
    const ref = React.createRef();
    const socket = { id: 'self', on() {}, off() {}, emit() {} };
    const render = (name) => React.createElement(VoiceChannel, {
      ref, canal: { id: 'voice', nome: name }, socket,
    });
    await act(async () => {
      renderer = TestRenderer.create(render('Voz'), {
        createNodeMock: ({ type }) => type === 'video' ? videoElement : null,
      });
    });
    await act(async () => ref.current.iniciarCompartilhamento({ stream, shareAudio: false }));
    await act(async () => ref.current.alternarTransmissao('self'));
    assert.equal(renderer.root.findAllByType('video').length, 1);
    assert.deepEqual(assignments, [stream]);

    for (let index = 0; index < 6; index += 1) {
      await act(async () => renderer.update(render(`Voz ${index}`)));
    }
    assert.deepEqual(assignments, [stream], 'reassigning the same srcObject reloads playback in Chromium');

    await act(async () => ref.current.pararCompartilhamento());
    assert.equal(renderer.root.findAllByType('video').length, 0);
    const replacement = { ...stream };
    await act(async () => ref.current.iniciarCompartilhamento({ stream: replacement, shareAudio: false }));
    await act(async () => ref.current.alternarTransmissao('self'));
    await act(async () => renderer.update(render('Nova transmissão')));
    assert.deepEqual(assignments, [stream, replacement], 'starting another capture must attach the replacement once');
    assert.equal(renderer.root.findByType('video').props.muted, true);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
