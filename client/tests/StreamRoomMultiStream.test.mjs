import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalPeerConnection = globalThis.RTCPeerConnection;
let vite;
let StreamRoom;
const renderers = [];

class FakePeerConnection {
  constructor() {
    this.remoteDescription = null;
    this.localDescription = null;
    this.connectionState = 'new';
    this.senders = [];
    FakePeerConnection.instances.push(this);
  }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async setLocalDescription(value) { this.localDescription = value; }
  async createAnswer() { return { type: 'answer', sdp: 'viewer' }; }
  async createOffer() { return { type: 'offer', sdp: 'presenter' }; }
  async addIceCandidate() {}
  getSenders() { return this.senders; }
  addTrack(track) { this.senders.push({ track, getParameters: () => ({}), setParameters: async () => {} }); }
  close() { this.connectionState = 'closed'; }
}
FakePeerConnection.instances = [];

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

after(async () => vite?.close());

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  if (originalPeerConnection === undefined) delete globalThis.RTCPeerConnection;
  else globalThis.RTCPeerConnection = originalPeerConnection;
});

async function showRoom(presenters, { socketId = 'watcher', localStream = null, reservedPresenterSlot = false, onStopShare = () => {} } = {}) {
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
  const listeners = new Map();
  const socket = {
    id: socketId,
    connected: true,
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    off(name, handler) { listeners.get(name)?.delete(handler); },
    emit(name, payload, ack) {
      if (typeof ack === 'function') ack({ ok: true, room: { id: 'room-1', name: 'Partida', presenters, isLive: presenters.length > 0 }, peerSocketIds: [] });
    },
  };
  const dispatch = async (name, payload) => act(async () => {
    await Promise.all([...(listeners.get(name) || [])].map((handler) => handler(payload)));
  });
  const room = { id: 'room-1', name: 'Partida', ownerName: 'Anfitrião', viewerCount: 3, isLive: presenters.length > 0, presenters, reservedPresenterSlot };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(StreamRoom, {
      socket, roomId: 'room-1', role: 'viewer', room, joinedInitially: true,
      localStream, onRequestShare() {}, onStopShare, onExit() {},
    }), { createNodeMock: ({ type }) => type === 'video'
      ? { srcObject: null, volume: 1, muted: true, play: async () => {} }
      : null });
  });
  renderers.push(renderer);
  return { renderer, dispatch };
}

test('two presenters appear as selectable thumbnails and a third share is disabled', async () => {
  const { renderer } = await showRoom([
    { socketId: 'alex', name: 'Alex' },
    { socketId: 'bia', name: 'Bia' },
  ]);
  const tiles = renderer.root.findAll((node) => node.type === 'button' && node.props['data-stream-tile']);
  assert.equal(tiles.length, 2);
  assert.match(tiles[0].props['aria-label'], /Alex/);
  assert.match(tiles[1].props['aria-label'], /Bia/);
  assert.equal(renderer.root.findAllByProps({ 'data-stream-stage-video': true }).length, 0);
  assert.equal(tiles[0].props['aria-pressed'], false);
  await act(async () => tiles[0].props.onClick());
  assert.equal(renderer.root.findAllByProps({ 'data-stream-stage-video': true }).length, 0);
  assert.equal(renderer.root.findAllByType('h2').some((node) => node.children.includes('Conectando à transmissão…')), true);
  const share = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Compartilhar tela');
  assert.equal(share.props.disabled, true);
});

test('a second member can share while only one presenter is active', async () => {
  const { renderer } = await showRoom([{ socketId: 'alex', name: 'Alex' }]);
  const share = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Compartilhar tela');
  assert.equal(share.props.disabled, false);
});

test('a reserved reconnect slot disables a third capture while one presenter remains', async () => {
  const { renderer } = await showRoom([{ socketId: 'bia', name: 'Bia' }], { reservedPresenterSlot: true });
  const share = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Compartilhar tela');
  assert.equal(share.props.disabled, true);
});

test('closing the room stops an active local capture', async () => {
  let stops = 0;
  const stream = { getTracks: () => [] };
  const { dispatch } = await showRoom([{ socketId: 'watcher', name: 'Você' }], {
    localStream: stream,
    onStopShare: () => { stops += 1; },
  });
  await dispatch('sala:encerrada', { salaId: 'room-1' });
  assert.equal(stops, 1);
});

test('switching selected streams mutes the newly selected stream until audio is enabled', async () => {
  const { renderer, dispatch } = await showRoom([
    { socketId: 'alex', name: 'Alex' },
    { socketId: 'bia', name: 'Bia' },
  ]);
  for (const socketId of ['alex', 'bia']) {
    await dispatch('sala:sinal:oferta', {
      roomId: 'room-1', de: socketId, streamId: socketId,
      descricao: { type: 'offer', sdp: socketId },
    });
    const peer = FakePeerConnection.instances.at(-1);
    await act(async () => peer.ontrack({ streams: [{ id: `media-${socketId}`, getAudioTracks: () => [{ id: `audio-${socketId}` }] }] }));
  }
  const tileVideos = renderer.root.findAll((node) => node.type === 'video' && node.props['data-stream-thumbnail']);
  assert.equal(tileVideos.length, 2);
  assert.ok(tileVideos.every((node) => node.props.muted === true));
  const tiles = renderer.root.findAll((node) => node.type === 'button' && node.props['data-stream-tile']);
  await act(async () => tiles[0].props.onClick());
  const mute = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Silenciar áudio');
  await act(async () => mute.props.onClick());
  assert.equal(renderer.root.findByProps({ 'data-stream-stage-video': true }).props.muted, false);
  await act(async () => tiles[1].props.onClick());
  assert.equal(renderer.root.findByProps({ 'data-stream-stage-video': true }).props.muted, true);
  assert.ok(renderer.root.findAll((node) => node.type === 'video' && node.props['data-stream-thumbnail']).every((node) => node.props.muted === true));
  const unmuteSelected = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Silenciar áudio');
  await act(async () => unmuteSelected.props.onClick());
  assert.equal(renderer.root.findByProps({ 'data-stream-stage-video': true }).props.muted, false);
  const back = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Voltar às transmissões');
  await act(async () => back.props.onClick());
  assert.equal(renderer.root.findAll((node) => node.type === 'video' && node.props.muted === false).length, 0);
});
