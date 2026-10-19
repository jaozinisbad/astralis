// Explicit Electron regression check: node_modules/.bin/electron tests/screenCaptureDimensions.native.cjs
// Captures one temporary BrowserWindow through getMediaSourceId in an isolated
// in-memory session. This checks real media dimensions, not external game/WGC behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  throw new Error('Run this check with Electron, not Node.js.');
}

const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'astralis-capture-dimensions-')));

const sourceRoot = path.resolve(__dirname, '../src');
const samplePage = `<!doctype html><meta charset="utf-8"><title>Astralis capture regression source</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:100%;height:100%}</style>
<canvas></canvas><script>
const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');let tick=0;
function draw(){canvas.width=innerWidth;canvas.height=innerHeight;context.fillStyle=tick++%2?'#d43c36':'#3473c5';context.fillRect(0,0,canvas.width,canvas.height);requestAnimationFrame(draw)}draw();
</script>`;

const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(samplePage);
    return;
  }
  const name = request.url.slice(1);
  if (!['screenCapture.mjs', 'streamQuality.mjs', 'audioSampleQueue.mjs'].includes(name)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/javascript' });
  response.end(fs.readFileSync(path.join(sourceRoot, name)));
});

async function run() {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const partition = `capture-dimensions-${Date.now()}`;
  session.fromPartition(partition).setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  const source = new BrowserWindow({
    width: 640, height: 480, useContentSize: true, frame: false, thickFrame: false,
    title: 'Astralis capture regression source', show: false,
    webPreferences: { partition, backgroundThrottling: false },
  });
  const controller = new BrowserWindow({ show: false, webPreferences: { partition, backgroundThrottling: false } });
  try {
    await source.loadURL(origin);
    source.showInactive();
    await source.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await controller.loadURL(origin);
    const sourceId = source.getMediaSourceId();
    await controller.webContents.executeJavaScript(`(async () => {
      globalThis.captureModule = await import('/screenCapture.mjs');
      globalThis.capturedStream = await captureModule.requestScreenCapture({
        fonteId: ${JSON.stringify(sourceId)}, resolution: '1080p', shareAudio: false,
      }, {});
      globalThis.video = document.createElement('video');
      video.muted = true; video.srcObject = capturedStream; document.body.append(video); await video.play();
    })()`);
    const measurements = [];
    for (const [width, height] of [[640, 480], [480, 720], [800, 600], [2560, 1440]]) {
      source.setContentSize(width, height);
      const pixels = await source.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => resolve({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio })))`);
      const scale = Math.min(1, 1920 / pixels.width, 1080 / pixels.height);
      const expected = { width: Math.floor(pixels.width * scale / 2) * 2, height: Math.floor(pixels.height * scale / 2) * 2 };
      const measured = await controller.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Capture did not follow source dimensions: ' + video.videoWidth + 'x' + video.videoHeight + ', expected ${expected.width}x${expected.height}')), 7000);
        const inspect = () => {
          if (Math.abs(video.videoWidth - ${expected.width}) <= 2 && Math.abs(video.videoHeight - ${expected.height}) <= 2) {
            clearTimeout(timeout); resolve({ width: video.videoWidth, height: video.videoHeight, settings: capturedStream.getVideoTracks()[0].getSettings(), audioTracks: capturedStream.getAudioTracks().length });
          } else video.requestVideoFrameCallback(inspect);
        }; video.requestVideoFrameCallback(inspect);
      })`);
      assert.ok(measured.width <= 1920 && measured.height <= 1080);
      assert.ok(measured.width <= pixels.width && measured.height <= pixels.height, 'capture must not upscale a small source');
      assert.ok(Math.abs(measured.width / measured.height - pixels.width / pixels.height) < 0.01, 'capture must preserve the source aspect ratio');
      assert.equal(measured.settings.frameRate, 60);
      assert.equal(measured.audioTracks, 0);
      measurements.push({ source: pixels, captured: measured });
    }
    console.log(JSON.stringify({ passed: true, electron: process.versions.electron, chrome: process.versions.chrome, measurements }, null, 2));
  } finally {
    if (!controller.isDestroyed()) {
      await controller.webContents.executeJavaScript('(async () => { if (globalThis.capturedStream) await captureModule.stopScreenCapture(capturedStream, {}); })()').catch(() => {});
      controller.destroy();
    }
    if (!source.isDestroyed()) source.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
