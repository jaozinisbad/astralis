import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
let vite;
let getPlaybackAgeSeconds;
let YouTubeRoomPlayer;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });
  ({ default: YouTubeRoomPlayer, getPlaybackAgeSeconds } = await vite.ssrLoadModule('/src/components/YouTubeRoomPlayer.jsx'));
});

after(async () => {
  await vite?.close();
});

test('converts numeric and ISO playback timestamps to elapsed seconds', () => {
  assert.equal(typeof getPlaybackAgeSeconds, 'function');
  assert.equal(getPlaybackAgeSeconds(1_000, 6_500), 5.5);
  assert.equal(getPlaybackAgeSeconds(new Date(1_000).toISOString(), 6_500), 5.5);
});

test('ignores invalid, future, and implausibly old playback timestamps', () => {
  assert.equal(typeof getPlaybackAgeSeconds, 'function');
  assert.equal(getPlaybackAgeSeconds('not-a-date', 6_500), 0);
  assert.equal(getPlaybackAgeSeconds(7_000, 6_500), 0);
  assert.equal(getPlaybackAgeSeconds(1_000, 90_000), 89);
  assert.equal(getPlaybackAgeSeconds(1_000, 86_402_000), 0);
});

function criarPlayerFake() {
  return class FakeYouTubePlayer {
    constructor(_container, options) {
      this.options = options;
      this.state = -1;
      this.currentTime = 12;
      this.duration = 150;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.seekCalls = [];
      FakeYouTubePlayer.instance = this;
      queueMicrotask(() => options.events.onReady({ target: this }));
    }

    getIframe() { return { setAttribute() {} }; }
    getDuration() { return this.duration; }
    getCurrentTime() { return this.currentTime; }
    getPlayerState() { return this.state; }
    playVideo() {
      this.playCalls += 1;
      this.state = 1;
      this.options.events.onStateChange({ data: 1, target: this });
    }
    pauseVideo() {
      this.pauseCalls += 1;
      this.state = 2;
      this.options.events.onStateChange({ data: 2, target: this });
    }
    seekTo(time) { this.seekCalls.push(time); this.currentTime = time; }
    destroy() {}
  };
}

async function withFakeYouTube(callback) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const FakePlayer = criarPlayerFake();
  globalThis.document = {};
  globalThis.window = {
    location: { origin: 'https://astralis.example' },
    YT: { Player: FakePlayer },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  try {
    await callback(FakePlayer);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test('local YouTube play/pause interactions send a room command with the current position', async () => {
  await withFakeYouTube(async (FakePlayer) => {
    const commands = [];
    let renderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(YouTubeRoomPlayer, {
          videoId: 'dQw4w9WgXcQ',
          playback: { action: 'pause', currentTime: 12, updatedAt: new Date().toISOString(), revision: 1 },
          onPlaybackCommand: (action, time) => commands.push([action, time]),
        }), { createNodeMock: () => ({}) });
        await new Promise((resolve) => setImmediate(resolve));
      });

      const playButton = renderer.root.findByProps({ 'aria-label': 'Reproduzir vídeo' });
      await act(async () => playButton.props.onClick());
      assert.deepEqual(commands, [['play', 12]]);

      const pauseButton = renderer.root.findByProps({ 'aria-label': 'Pausar vídeo' });
      await act(async () => pauseButton.props.onClick());
      assert.deepEqual(commands, [['play', 12], ['pause', 12]]);
      assert.equal(FakePlayer.instance.options.playerVars.controls, 0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });
});

test('remote YouTube playback commands update the player without echoing to the room', async () => {
  await withFakeYouTube(async (FakePlayer) => {
    const commands = [];
    let renderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(YouTubeRoomPlayer, {
          videoId: 'dQw4w9WgXcQ',
          playback: { action: 'play', currentTime: 22, updatedAt: new Date().toISOString(), revision: 1 },
          onPlaybackCommand: (action, time) => commands.push([action, time]),
        }), { createNodeMock: () => ({}) });
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.ok(FakePlayer.instance.playCalls > 0, 'the shared play state should be applied to YouTube');

      await act(async () => renderer.update(React.createElement(YouTubeRoomPlayer, {
        videoId: 'dQw4w9WgXcQ',
        playback: { action: 'play', currentTime: 63, updatedAt: new Date().toISOString(), revision: 2 },
        onPlaybackCommand: (action, time) => commands.push([action, time]),
      })));
      assert.ok(Math.abs(FakePlayer.instance.seekCalls.at(-1) - 63) < 0.1);
      assert.deepEqual(commands, [], 'remote updates must not be broadcast back again');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });
});
