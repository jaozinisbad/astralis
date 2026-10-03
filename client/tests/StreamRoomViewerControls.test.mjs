import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let StreamRoom;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const renderers = [];
let peerConnections;

class FakePeerConnection {
  constructor() { peerConnections.push(this); this.remoteDescription = null; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async createAnswer() { return { type: 'answer', sdp: 'viewer-answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async addIceCandidate() {}
  getSenders() { return []; }
  close() {}
}

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ default: StreamRoom } = await vite.ssrLoadModule('/src/components/StreamRoom.jsx'));
});

after(async () => {
  await vite?.close();
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  if (originalRTCPeerConnection === undefined) delete globalThis.RTCPeerConnection;
  else globalThis.RTCPeerConnection = originalRTCPeerConnection;
});

async function renderViewer({ volumeWritable = true, nativeFullscreen = false, fullscreenRejects = false } = {}) {
  peerConnections = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
  let playCalls = 0;
  const videoNode = { volume: 1, muted: true, play: async () => { playCalls += 1; } };
  let fullscreenCalls = 0;
  const stageNode = nativeFullscreen ? { requestFullscreen: async () => { fullscreenCalls += 1; if (fullscreenRejects) throw new Error('denied'); } } : {};
  if (!volumeWritable) Object.defineProperty(videoNode, 'volume', { get: () => 1, set() {} });
  const listeners = new Map();
  const socket = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    emit(_event, _payload, callback) { callback?.({ ok: true, room: { id: 'room-1', name: 'Partida' } }); },
  };
  let exitCalls = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(StreamRoom, {
      socket,
      roomId: 'room-1',
      role: 'viewer',
      room: { id: 'room-1', name: 'Partida', isLive: true },
      onExit() { exitCalls += 1; },
    }), { createNodeMock: ({ type, props }) => type === 'video' ? videoNode : type === 'section' && props.className?.startsWith('stream-stage') ? stageNode : null });
  });
  renderers.push(renderer);
  await act(async () => {
    await listeners.get('sala:sinal:oferta')({
      roomId: 'room-1', de: 'host-1', descricao: { type: 'offer', sdp: 'host-offer' },
    });
    peerConnections[0].ontrack({ streams: [{ getAudioTracks: () => [{ id: 'audio-1' }] }] });
  });
  return { renderer, videoNode, stageNode, getExitCalls: () => exitCalls, getPlayCalls: () => playCalls, getFullscreenCalls: () => fullscreenCalls,
    endRemoteStream: async () => act(async () => peerConnections[0].ontrack({ streams: [] })) };
}

test('viewer media uses custom playback controls instead of native video controls', async () => {
  const { renderer } = await renderViewer();
  const video = renderer.root.findByType('video');
  assert.equal(video.props.controls, undefined, 'native controls expose browser pause/play controls');
});

test('viewer volume slider updates the media volume', async () => {
  const { renderer, videoNode } = await renderViewer();
  const slider = renderer.root.findAll((node) => node.type === 'input' && node.props.type === 'range')[0];
  assert.ok(slider, 'viewer should have a custom volume slider');
  assert.equal(typeof slider.props.onChange, 'function');
  await act(async () => slider.props.onChange({ target: { value: '35' } }));
  assert.equal(videoNode.volume, 0.35);
});

test('viewer has a mute control with an accessible mute state', async () => {
  const { renderer } = await renderViewer();
  const muteButton = renderer.root.findAllByType('button').find((button) =>
    /mute|silenciar|áudio/i.test(`${button.props['aria-label'] || ''} ${button.children.join(' ')}`));
  assert.ok(muteButton, 'viewer should have a mute icon button');
  assert.equal(typeof muteButton.props['aria-pressed'], 'boolean', 'mute state should be exposed accessibly');
  assert.equal(muteButton.props['aria-pressed'], true, 'audio starts muted');
  await act(async () => muteButton.props.onClick());
  const unmutedButton = renderer.root.findAllByType('button').find((button) =>
    /mute|silenciar|áudio/i.test(`${button.props['aria-label'] || ''} ${button.children.join(' ')}`));
  assert.equal(unmutedButton.props['aria-pressed'], false, 'mute button toggles to unmuted');
});

test('viewer omits the volume slider when the browser ignores media volume changes', async () => {
  const { renderer } = await renderViewer({ volumeWritable: false });
  assert.equal(renderer.root.findAll((node) => node.type === 'input' && node.props.type === 'range').length, 0);
  assert.ok(renderer.root.findAllByType('button').some((button) => /áudio/i.test(button.props['aria-label'] || '')));
});

test('viewer offers a play-only recovery if browser playback pauses', async () => {
  const { renderer, getPlayCalls } = await renderViewer();
  const video = renderer.root.findByType('video');
  assert.equal(typeof video.props.onPause, 'function');
  await act(async () => video.props.onPause());
  const playButton = renderer.root.findAllByType('button').find((button) => /iniciar vídeo/i.test(button.children.join(' ')));
  assert.ok(playButton);
  await act(async () => playButton.props.onClick());
  assert.ok(getPlayCalls() > 0);
});

test('viewer uses an in-page fullscreen fallback when native element fullscreen is unavailable', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer } = await renderViewer();
    const fullscreenButton = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Tela cheia');
    await act(async () => fullscreenButton.props.onClick());
    assert.match(renderer.root.findByProps({ 'aria-label': 'Tela transmitida' }).props.className, /is-pseudo-fullscreen/);
    await act(async () => fullscreenButton.props.onClick());
    assert.doesNotMatch(renderer.root.findByProps({ 'aria-label': 'Tela transmitida' }).props.className, /is-pseudo-fullscreen/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer leaves in-page fullscreen when the host stops sharing', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer, endRemoteStream } = await renderViewer();
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Tela cheia');
    await act(async () => button.props.onClick());
    await endRemoteStream();
    assert.doesNotMatch(renderer.root.findByProps({ 'aria-label': 'Tela transmitida' }).props.className, /is-pseudo-fullscreen/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer falls back to in-page fullscreen when native fullscreen is rejected', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer } = await renderViewer({ nativeFullscreen: true, fullscreenRejects: true });
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Tela cheia');
    await act(async () => button.props.onClick());
    assert.match(renderer.root.findByProps({ 'aria-label': 'Tela transmitida' }).props.className, /is-pseudo-fullscreen/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer exits native fullscreen when the host stops sharing', async () => {
  const previousDocument = globalThis.document;
  let exits = 0;
  globalThis.document = { fullscreenElement: null, exitFullscreen: async () => { exits += 1; } };
  try {
    const { stageNode, endRemoteStream } = await renderViewer({ nativeFullscreen: true });
    globalThis.document.fullscreenElement = stageNode;
    await endRemoteStream();
    assert.equal(exits, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer can request picture-in-picture and fullscreen playback', async () => {
  const { renderer } = await renderViewer();
  const buttons = renderer.root.findAllByType('button');
  assert.ok(buttons.some((button) => /picture.?in.?picture|picture-in-picture|pip/i.test(
    `${button.props['aria-label'] || ''} ${button.children.join(' ')}`)), 'viewer should have a picture-in-picture control');
  assert.ok(buttons.some((button) => /fullscreen|full screen|tela cheia/i.test(
    `${button.props['aria-label'] || ''} ${button.children.join(' ')}`)), 'viewer should have a fullscreen control');
});

test('viewer invokes browser picture-in-picture when available', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { pictureInPictureElement: null };
  try {
    const { renderer, videoNode } = await renderViewer();
    let pictureInPictureCalls = 0;
    videoNode.requestPictureInPicture = async () => { pictureInPictureCalls += 1; };
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Picture-in-picture');
    await act(async () => button.props.onClick());
    assert.equal(pictureInPictureCalls, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer invokes native element fullscreen when available', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer, getFullscreenCalls } = await renderViewer({ nativeFullscreen: true });
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Tela cheia');
    await act(async () => button.props.onClick());
    assert.equal(getFullscreenCalls(), 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer can stop watching and invokes the exit callback', async () => {
  const { renderer, getExitCalls } = await renderViewer();
  const exitButton = renderer.root.findAllByType('button').find((button) =>
    /stop watching|parar de assistir|sair da sala/i.test(`${button.props['aria-label'] || ''} ${button.children.join(' ')}`));
  assert.ok(exitButton, 'viewer should have a stop-watching action');
  await act(async () => exitButton.props.onClick());
  assert.equal(getExitCalls(), 1, 'stop-watching action should notify the parent to exit');
});
