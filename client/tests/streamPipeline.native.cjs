// Run explicitly with Electron, never against the production signaling service.
// electron tests/streamPipeline.native.cjs <absolute-result.json>
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'astralis-stream-pipeline-')));
const root = path.resolve(__dirname, '../src');
const output = process.argv[2];

async function browserRun() {
  const { createStreamRoomPeerSession } = await import('/src/streamRoomPeer.mjs');
  const { resolveVideoCodecPreferences } = await import('/src/streamCodecs.mjs');
  const { summarizeWebRtcStats } = await import('/src/streamStats.mjs');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await wait(50);
    }
    throw new Error('Timed out waiting for local WebRTC media');
  };
  class Socket {
    constructor(id, sockets) { this.id = id; this.sockets = sockets; this.listeners = new Map(); sockets.set(id, this); }
    on(event, listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(listener); }
    off(event, listener) { this.listeners.get(event)?.delete(listener); }
    emit(event, message, acknowledge) {
      acknowledge?.({ ok: true });
      if (!event.startsWith('sala:sinal:')) return;
      const receiver = this.sockets.get(message.para);
      queueMicrotask(() => receiver?.listeners.get(event)?.forEach((listener) => listener({ ...message, de: this.id })));
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  let frame = 0;
  const draw = () => {
    ctx.fillStyle = '#152c53'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < 80; index += 1) {
      ctx.fillStyle = `hsl(${index * 13 + frame},70%,55%)`;
      ctx.fillRect((frame * 12 + index * 73) % 1920, (index * 89) % 1080, 100, 45);
    }
    ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(`Astralis local validation — ${frame++}`, 40, 80);
  };
  draw();
  const drawing = setInterval(draw, 1000 / 60);
  const stream = canvas.captureStream(60);
  const result = { userAgent: navigator.userAgent, capture: stream.getVideoTracks()[0].getSettings(), capabilities: [], cases: [] };
  const senderCodecs = RTCRtpSender.getCapabilities('video').codecs;
  for (const codec of senderCodecs.filter((codec) => !/\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType))) {
    const configuration = { type: 'webrtc', video: { contentType: codec.mimeType + (codec.sdpFmtpLine ? `;${codec.sdpFmtpLine}` : ''), width: 1920, height: 1080, bitrate: 16_000_000, framerate: 60 } };
    try { result.capabilities.push({ codec, info: await navigator.mediaCapabilities.encodingInfo(configuration) }); }
    catch (error) { result.capabilities.push({ codec, error: error.message }); }
  }
  try {
    for (const [label, viewers, efficient] of [['browser-default', 1, false], ['efficient-preference', 1, true], ['two-viewers', 2, true]]) {
      const sockets = new Map();
      const errors = [];
      const received = [];
      const timeline = [];
      const startedAt = performance.now();
      let diagnostics;
      const host = createStreamRoomPeerSession({
        socket: new Socket('host', sockets), roomId: 'local-room', role: 'host', streamId: 'host', iceServers: [],
        resolveVideoCodecPreferencesImpl: efficient ? resolveVideoCodecPreferences : async () => [],
        onStats: (stats) => {
          diagnostics = stats;
          timeline.push({ elapsedMs: Math.round(performance.now() - startedAt), peers: stats.peers.map((peer) => ({
            peerId: peer.peerId, cap: peer.targetVideoBitrate, estimate: peer.availableOutgoingBitrate, metrics: peer.metrics,
          })) });
        },
        onQualityError: (error) => errors.push(String(error)), onSignalError: (error) => errors.push(String(error.error)),
      });
      const sessions = [];
      for (let index = 0; index < viewers; index += 1) {
        const video = document.createElement('video');
        video.autoplay = true; video.muted = true; video.width = 320;
        document.body.append(video);
        sessions.push(createStreamRoomPeerSession({
          socket: new Socket(`viewer-${index}`, sockets), roomId: 'local-room', role: 'viewer', streamId: 'host', iceServers: [],
          onRemoteStream: (_peerId, remote) => { if (remote) { video.srcObject = remote; received[index] = video; } },
          onSignalError: (error) => errors.push(String(error.error)),
        }));
      }
      try {
        host.setLocalStream(stream);
        await host.setViewers(Array.from({ length: viewers }, (_, index) => `viewer-${index}`));
        await until(() => received.length === viewers && received.every((video) => video?.videoWidth > 0));
        await wait(12000);
        await host.refreshStats();
        await wait(8000);
        await host.refreshStats();
        const decoded = [];
        for (const session of sessions) {
          let snapshot;
          // Renderer elements prove actual decode; session stats are collected by production code.
          await session.refreshStats();
          snapshot = session.getPeerCount();
          decoded.push(snapshot);
        }
        const frames = received.map((video) => ({ width: video.videoWidth, height: video.videoHeight, decoded: video.getVideoPlaybackQuality().totalVideoFrames }));
        result.cases.push({ label, errors, diagnostics, frames, connections: decoded, timeline });
        if (errors.length || frames.some((video) => video.decoded < 30)) throw new Error(`Local decode failed for ${label}`);
      } finally {
        host.close(); sessions.forEach((session) => session.close()); received.forEach((video) => { video.srcObject = null; video.remove(); });
      }
    }
  } finally {
    clearInterval(drawing); stream.getTracks().forEach((track) => track.stop()); canvas.remove();
  }
  // Verify that inbound reports continue exposing only receiver metrics.
  if (summarizeWebRtcStats([]).metrics.encoderImplementation !== null) throw new Error('Unexpected empty encoder metrics');
  return result;
}

let server;
let window;
const watchdog = setTimeout(() => { console.error('Native pipeline validation timed out'); app.exit(1); }, 150_000);
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Astralis isolated stream validation</title><body></body>');
      return;
    }
    const filename = path.resolve(root, '.' + request.url.replace(/^\/src/, ''));
    if (!filename.startsWith(root + path.sep) || !filename.endsWith('.mjs') || !fs.existsSync(filename)) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(filename));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  const result = await window.webContents.executeJavaScript(`(${browserRun.toString()})()`);
  result.versions = process.versions;
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));
  for (const item of result.cases) {
    assert.equal(item.errors.length, 0);
    assert.ok(item.diagnostics.peers.every((peer) => peer.connectionState === 'connected'));
    assert.ok(item.diagnostics.peers.reduce((sum, peer) => sum + peer.targetVideoBitrate, 0) <= 16_000_000);
    // maintain-framerate allows the native congestion/CPU controller to reduce
    // encoded dimensions. Validate the selected ceiling and aspect, not a forced
    // output size that would disable that production behavior.
    assert.ok(item.frames.every((frame) => frame.width > 0 && frame.height > 0
      && frame.width <= 1920 && frame.height <= 1080 && Math.abs(frame.width / frame.height - 16 / 9) < 0.02));
  }
  console.log(JSON.stringify(result.cases.map(({ label, frames, diagnostics }) => ({ label, frames, peers: diagnostics.peers.map(({ metrics, targetVideoBitrate }) => ({ targetVideoBitrate, metrics })) })), null, 2));
}).then(() => { clearTimeout(watchdog); window?.destroy(); server?.close(); app.exit(0); }).catch((error) => {
  console.error(error); clearTimeout(watchdog); window?.destroy(); server?.close(); app.exit(1);
});
