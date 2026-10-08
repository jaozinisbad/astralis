import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';
import { parseYouTubeVideoId } from '../src/youtubeVideoId.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const screenRoomsCss = readFileSync(new URL('../src/screen-rooms.css', import.meta.url), 'utf8');
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

async function renderViewer({ volumeWritable = true, nativeFullscreen = false, fullscreenRejects = false, nativeVideoFullscreen = false, room = { id: 'room-1', name: 'Partida', isLive: true, presenterSocketId: 'host-1', presenterName: 'Anfitrião' }, entryRoom = room, requiredAccessCode = null, socketId = 'viewer-1', onRequestShare = () => {}, onStopShare = () => {}, localStream = null, joinedInitially = false, accessCode = '', role = 'viewer', deferRoomEntries = false } = {}) {
  peerConnections = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
  let playCalls = 0;
  let videoFullscreenCalls = 0;
  const videoNode = {
    volume: 1,
    muted: true,
    webkitSupportsFullscreen: nativeVideoFullscreen,
    webkitEnterFullscreen: nativeVideoFullscreen ? () => { videoFullscreenCalls += 1; } : undefined,
    play: async () => { playCalls += 1; },
  };
  let fullscreenCalls = 0;
  const stageNode = nativeFullscreen ? { requestFullscreen: async () => { fullscreenCalls += 1; if (fullscreenRejects) throw new Error('denied'); } } : {};
  if (!volumeWritable) Object.defineProperty(videoNode, 'volume', { get: () => 1, set() {} });
  const listeners = new Map();
  const emittedEvents = [];
  const emittedPayloads = [];
  const pendingRoomEntries = [];
  const socket = {
    id: socketId,
    connected: true,
    on(event, listener) {
      let dispatch = listeners.get(event);
      if (!dispatch) {
        dispatch = (...args) => Promise.all([...dispatch.handlers].map((handler) => handler(...args)));
        dispatch.handlers = new Set();
        listeners.set(event, dispatch);
      }
      dispatch.handlers.add(listener);
    },
    off(event, listener) {
      const dispatch = listeners.get(event);
      dispatch?.handlers.delete(listener);
      if (dispatch?.handlers.size === 0) listeners.delete(event);
    },
    emit(event, payload, callback) {
      emittedEvents.push(event);
      emittedPayloads.push({ event, payload });
      if (event === 'salas:entrar') {
        if (deferRoomEntries) pendingRoomEntries.push({ payload, callback });
        else callback?.(requiredAccessCode && payload?.accessCode !== requiredAccessCode
          ? { ok: false, error: 'Código de acesso inválido.' }
          : { ok: true, room: { ...entryRoom }, presenterSocketId: entryRoom.presenterSocketId ?? null, youtubeSource: entryRoom.youtubeSource || null, youtubePlayback: entryRoom.youtubePlayback || null });
      } else if (event === 'salas:ao-vivo' && payload?.isLive) {
        callback?.({ ok: true, room: { ...room, isLive: true, presenterSocketId: socket.id, presenterName: 'Visitante' }, presenterSocketId: socket.id, presenterName: 'Visitante', peerSocketIds: [] });
      } else if (event === 'sala:youtube:fonte') {
        callback?.({ ok: true, source: payload.videoId ? { videoId: payload.videoId } : null, playback: { action: payload.videoId ? 'play' : 'pause', currentTime: 0, updatedAt: Date.now(), revision: 1 } });
      } else if (event === 'sala:youtube:reproducao') {
        callback?.({ ok: true, playback: { action: payload.action, currentTime: payload.currentTime, updatedAt: Date.now(), revision: 1 } });
      } else callback?.({ ok: true, room: { ...room } });
    },
  };
  let exitCalls = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(StreamRoom, {
      socket,
      roomId: 'room-1',
      role,
      room,
      accessCode,
      localStream,
      joinedInitially,
      onRequestShare,
      onStopShare,
      onExit() { exitCalls += 1; },
    }), { createNodeMock: ({ type, props }) => type === 'video'
      ? props['data-stream-stage-video'] ? videoNode : { volume: 1, muted: true, srcObject: null, play: async () => {} }
      : type === 'section' && props.className?.startsWith('stream-stage') ? stageNode : null });
  });
  renderers.push(renderer);
  if (room.isLive && room.presenterSocketId !== socketId) {
    await act(async () => {
      await listeners.get('sala:sinal:oferta')({
        roomId: 'room-1', de: room.presenterSocketId, streamId: room.presenterSocketId,
        descricao: { type: 'offer', sdp: 'host-offer' },
      });
      peerConnections[0].ontrack({ streams: [{ getAudioTracks: () => [{ id: 'audio-1' }] }] });
    });
  }
  return { renderer, videoNode, stageNode, socket, listeners, pendingRoomEntries, getExitCalls: () => exitCalls, getPlayCalls: () => playCalls, getFullscreenCalls: () => fullscreenCalls, getVideoFullscreenCalls: () => videoFullscreenCalls, emittedEvents, emittedPayloads,
    endRemoteStream: async () => act(async () => peerConnections[0].ontrack({ streams: [] })) };
}

test('viewer media uses custom playback controls instead of native video controls', async () => {
  const { renderer } = await renderViewer();
  const video = renderer.root.findByProps({ 'data-stream-stage-video': true });
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
  const video = renderer.root.findByProps({ 'data-stream-stage-video': true });
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

test('fullscreen controls and viewer pointer hide after inactivity and return on pointer movement', async () => {
  const previousDocument = globalThis.document;
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer } = await renderViewer();
    const stage = () => renderer.root.findByProps({ 'aria-label': 'Tela transmitida' });
    const fullscreenButton = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Tela cheia');
    await act(async () => fullscreenButton.props.onClick());

    await act(async () => mock.timers.tick(1799));
    assert.doesNotMatch(stage().props.className, /is-controls-hidden/);
    await act(async () => mock.timers.tick(1));
    assert.match(stage().props.className, /is-controls-hidden/);
    assert.match(screenRoomsCss, /\.stream-stage\.is-controls-hidden\s*\{\s*cursor:\s*none;\s*\}/, 'the same idle fullscreen state hides the viewer-side cursor');

    await act(async () => stage().props.onPointerMove({}));
    assert.doesNotMatch(stage().props.className, /is-controls-hidden/);
    await act(async () => mock.timers.tick(1800));
    assert.match(stage().props.className, /is-controls-hidden/);
  } finally {
    mock.timers.reset();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('native fullscreenchange also hides controls after inactivity and restores them on exit', async () => {
  const previousDocument = globalThis.document;
  const listeners = new Map();
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.document = {
    fullscreenElement: null,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  try {
    const { renderer, stageNode } = await renderViewer({ nativeFullscreen: true });
    const stage = () => renderer.root.findByProps({ 'aria-label': 'Tela transmitida' });
    const fullscreenButton = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Tela cheia');
    await act(async () => fullscreenButton.props.onClick());
    globalThis.document.fullscreenElement = stageNode;
    await act(async () => listeners.get('fullscreenchange')());

    await act(async () => mock.timers.tick(1800));
    assert.match(stage().props.className, /is-controls-hidden/);
    globalThis.document.fullscreenElement = null;
    await act(async () => listeners.get('fullscreenchange')());
    assert.doesNotMatch(stage().props.className, /is-controls-hidden/);
  } finally {
    mock.timers.reset();
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

test('viewer uses the native video fullscreen API on iPhone Safari', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { fullscreenElement: null };
  try {
    const { renderer, getVideoFullscreenCalls, getFullscreenCalls } = await renderViewer({ nativeVideoFullscreen: true });
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Tela cheia');
    await act(async () => button.props.onClick());
    assert.equal(getVideoFullscreenCalls(), 1, 'the native video method should hide Safari chrome on iPhone');
    assert.equal(getFullscreenCalls(), 0, 'do not fullscreen only the page container on iPhone');
    assert.doesNotMatch(renderer.root.findByProps({ 'aria-label': 'Tela transmitida' }).props.className, /is-pseudo-fullscreen/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('viewer can stop watching one stream without leaving the room', async () => {
  const { renderer, getExitCalls } = await renderViewer();
  const exitButton = renderer.root.findAllByType('button').find((button) =>
    /stop watching|parar de assistir/i.test(`${button.props['aria-label'] || ''} ${button.children.join(' ')}`));
  assert.ok(exitButton, 'viewer should have a stop-watching action');
  await act(async () => exitButton.props.onClick());
  assert.equal(getExitCalls(), 0, 'stopping one stream keeps the viewer in the room');
  assert.equal(renderer.root.findAll((node) => node.type === 'video' && node.props.muted === false).length, 0);
  const leaveRoom = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Sair da sala');
  await act(async () => leaveRoom.props.onClick());
  assert.equal(getExitCalls(), 1);
});

test('a joined viewer can request screen sharing when the room is idle', async () => {
  let requests = 0;
  const { renderer } = await renderViewer({ room: { id: 'room-1', name: 'Partida', isLive: false }, onRequestShare: () => { requests += 1; } });
  const shareButton = renderer.root.findAllByType('button').find((button) => /compartilhar tela/i.test(button.children.join(' ')));
  assert.ok(shareButton, 'every room member should see the share action while the stage is empty');
  await act(async () => shareButton.props.onClick());
  assert.equal(requests, 1);
});

test('a viewer pre-joined by private access code opens the room without joining twice', async () => {
  const { renderer, emittedEvents } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: false },
    joinedInitially: true,
  });
  assert.equal(emittedEvents.includes('salas:entrar'), false);
  assert.ok(renderer.root.findAllByType('button').some((button) => /compartilhar tela/i.test(button.children.join(' '))));
});

test('a viewer already joined to a live room announces readiness after registering its peer listener', async () => {
  const { emittedEvents } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: true, presenterSocketId: 'presenter-a', presenterName: 'Ana' },
    joinedInitially: true,
  });
  assert.equal(emittedEvents.includes('sala:espectador-pronto'), true);
});

test('a transmitting member rejoins and restores the screen share after the socket reconnects', async () => {
  const localStream = { getTracks: () => [{ kind: 'video', id: 'screen-track' }] };
  const { socket, listeners, emittedEvents, emittedPayloads, renderer } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: true, presenterSocketId: 'viewer-1', presenterName: 'Visitante' },
    entryRoom: { id: 'room-1', name: 'Partida', isLive: false, presenterSocketId: null, presenterName: null },
    socketId: 'viewer-1',
    localStream,
    joinedInitially: true,
    accessCode: 'ROOM42',
  });
  await act(async () => {
    socket.connected = false;
    listeners.get('disconnect')();
  });
  await act(async () => {
    socket.id = 'viewer-2';
    socket.connected = true;
    await listeners.get('connect')();
  });
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  assert.equal(emittedEvents.filter((event) => event === 'salas:entrar').length, 1, 'reconnect should rejoin the room');
  assert.equal(emittedPayloads.find(({ event }) => event === 'salas:entrar').payload.accessCode, 'ROOM42');
  const restore = emittedPayloads.find(({ event, payload }) => event === 'salas:ao-vivo' && payload.isLive);
  assert.ok(restore, 'the captured screen should be announced again after rejoining');
  assert.ok(renderer.root.findByProps({ 'data-stream-stage-video': true }), 'the local capture remains attached');
});

test('a second socket interruption during room rejoin triggers another recovery attempt', async () => {
  const { socket, listeners, emittedPayloads, pendingRoomEntries } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: false },
    entryRoom: { id: 'room-1', name: 'Partida', isLive: false },
    joinedInitially: true,
    deferRoomEntries: true,
  });

  await act(async () => {
    socket.connected = false;
    listeners.get('disconnect')();
    socket.connected = true;
    listeners.get('connect')();
    await Promise.resolve();
  });
  assert.equal(emittedPayloads.filter(({ event }) => event === 'salas:entrar').length, 1);

  await act(async () => {
    socket.connected = false;
    listeners.get('disconnect')();
    socket.connected = true;
    listeners.get('connect')();
    await Promise.resolve();
  });
  const entryCount = emittedPayloads.filter(({ event }) => event === 'salas:entrar').length;
  const response = { ok: true, room: { id: 'room-1', name: 'Partida', isLive: false }, presenterSocketId: null };
  await act(async () => {
    pendingRoomEntries.forEach(({ callback }) => callback(response));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(entryCount, 2,
    'a reconnect arriving during a pending join should not consume the retry flag');
});

test('a viewer keeps a code entered in the room gate when the socket reconnects', async () => {
  const { socket, listeners, emittedPayloads, renderer } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: false },
    entryRoom: { id: 'room-1', name: 'Partida', isLive: false },
    requiredAccessCode: 'ROOM42',
  });

  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  const codeInput = renderer.root.findByProps({ id: 'stream-room-code' });
  await act(async () => codeInput.props.onChange({ target: { value: 'ROOM42' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));

  await act(async () => {
    socket.connected = false;
    listeners.get('disconnect')();
  });
  await act(async () => {
    socket.connected = true;
    await listeners.get('connect')();
  });

  const entries = emittedPayloads.filter(({ event }) => event === 'salas:entrar');
  assert.equal(entries.length, 3, 'the viewer should attempt the initial join, code join, and reconnect');
  assert.equal(entries.at(-1).payload.accessCode, 'ROOM42');
  assert.equal(renderer.root.findAllByProps({ children: 'Esta transmissão terminou' }).length, 0);
});

test('a member can share while only one other presenter is live', async () => {
  const { renderer } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', isLive: true, presenterSocketId: 'other-presenter', presenterName: 'Alex' },
  });
  const shareButton = renderer.root.findAllByType('button').find((button) => /compartilhar tela|transmitindo/i.test(button.children.join(' ')));
  assert.ok(shareButton, 'a second participant should see the sharing action');
  assert.equal(shareButton.props.disabled, false);
});

test('a member who is transmitting can stop their own screen share', async () => {
  let stops = 0;
  const stream = { getTracks: () => [] };
  const { renderer } = await renderViewer({
    localStream: stream,
    socketId: 'viewer-1',
    room: { id: 'room-1', name: 'Partida', isLive: true, presenterSocketId: 'viewer-1' },
    onStopShare: () => { stops += 1; },
  });
  const stopButton = renderer.root.findAllByType('button').find((button) => /parar transmissão/i.test(button.children.join(' ')));
  assert.ok(stopButton, 'a participant presenter should have a stop control');
  await act(async () => stopButton.props.onClick());
  assert.equal(stops, 1);
});

test('room uses a stage and participant sidebar with a bottom action dock', async () => {
  const { renderer } = await renderViewer({
    room: { id: 'room-1', name: 'Partida', ownerName: 'Júlia', viewerCount: 2, isLive: false },
  });

  assert.ok(renderer.root.findByProps({ className: 'stream-room-workspace' }));
  assert.ok(renderer.root.findByProps({ 'aria-label': 'Participantes da sala' }));
  assert.ok(renderer.root.findByProps({ className: 'stream-room-action-bar' }));
  assert.equal(renderer.root.findAll((node) => node.type === 'input' && /mensagem/i.test(node.props.placeholder || '')).length, 0);
  assert.equal(renderer.root.findAll((node) => node.type === 'button' && /microfone|fones|câmera/i.test(node.props['aria-label'] || '')).length, 0);
});

test('host can add one validated YouTube link and the video becomes the room stage', async () => {
  const { renderer, emittedPayloads } = await renderViewer({
    role: 'host',
    joinedInitially: true,
    room: { id: 'room-1', name: 'Partida', ownerName: 'Júlia', visibility: 'public', viewerCount: 0, isLive: false },
  });
  const addSource = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Adicionar fonte do YouTube');
  assert.ok(addSource);
  await act(async () => addSource.props.onClick());

  const input = renderer.root.findByProps({ id: 'stream-youtube-url' });
  await act(async () => input.props.onChange({ target: { value: 'https://youtu.be/dQw4w9WgXcQ' } }));
  const form = renderer.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault() {} }));

  assert.ok(emittedPayloads.some(({ event, payload }) => event === 'sala:youtube:fonte' && payload.videoId === 'dQw4w9WgXcQ'));
  assert.ok(renderer.root.findByProps({ className: 'youtube-room-player' }));
  assert.equal(renderer.root.findAllByType('video').length, 0, 'YouTube is embedded directly rather than captured as a screen stream');
});

test('host form accepts the scheme-less YouTube links supported by the parser', async () => {
  const { renderer } = await renderViewer({
    role: 'host',
    joinedInitially: true,
    room: { id: 'room-1', name: 'Partida', ownerName: 'Júlia', visibility: 'public', viewerCount: 0, isLive: false },
  });
  const addSource = renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Adicionar fonte do YouTube');
  await act(async () => addSource.props.onClick());

  const input = renderer.root.findByProps({ id: 'stream-youtube-url' });
  assert.equal(parseYouTubeVideoId('youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.notEqual(input.props.type, 'url', 'browser-native URL validation must not reject a supported scheme-less link');
});

test('a viewer entering a room with an existing YouTube source renders its direct player', async () => {
  const { renderer } = await renderViewer({
    room: {
      id: 'room-1', name: 'Partida', ownerName: 'Júlia', viewerCount: 1, isLive: false,
      youtubeSource: { videoId: 'dQw4w9WgXcQ' },
      youtubePlayback: { action: 'play', currentTime: 22, updatedAt: new Date().toISOString(), revision: 1 },
    },
    joinedInitially: true,
  });

  assert.ok(renderer.root.findByProps({ className: 'youtube-room-player' }));
  assert.equal(renderer.root.findAllByType('video').length, 0, 'YouTube playback does not use a WebRTC video element');
  assert.ok(renderer.root.findByProps({ className: 'youtube-room-player__controls' }));
});
