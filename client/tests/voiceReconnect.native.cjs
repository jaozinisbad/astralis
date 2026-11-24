// Run explicitly from client: electron tests/voiceReconnect.native.cjs
const { app, BrowserWindow } = require('electron');
const { Server } = require('../../server/node_modules/socket.io');
const { createDirectCallManager } = require('../../server/directCalls');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'astralis-reconnect-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.on('window-all-closed', () => {});
async function run() {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['react', 'react-dom/client', 'socket.io-client'] },
    plugins: [{ name: 'reconnect-test', configureServer(server) {
      server.middlewares.use('/voice-test', (_, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<div id="root"></div><script type="module" src="/tests/fixtures/voice-reconnect.mjs"></script>');
      });
    } }]
  });
  await vite.listen();
  const io = new Server(vite.httpServer);
  const manager = createDirectCallManager({ io, areFriends: async () => true, getUser: async id => ({ id, nome: String(id) }) });
  const clients = new Map();
  const windows = [];
  let holdOffers = false;
  const held = [];
  io.on('connection', s => {
    const id = s.handshake.auth.user;
    s.usuario = { id, nome: String(id) };
    clients.set(id, s);
    manager.register(s);
    s.on('entrar-canal-voz', channel => manager.joinVoice(s, channel));
    s.on('sair-canal-voz', () => manager.leaveVoice(s));
    s.on('disconnect', () => manager.disconnect(s));
    s.on('voz:ice-config', (_, ack) => ack({ ok: true, iceServers: [] }));
    for (const event of ['webrtc-oferta', 'webrtc-resposta', 'webrtc-candidato']) {
      s.on(event, data => {
        if (!manager.canSignal(s, data.para)) return;
        const deliver = () => io.to(data.para).emit(event, { ...data, de: s.id });
        if (holdOffers && event === 'webrtc-oferta') held.push(deliver);
        else deliver();
      });
    }
  });
  const read = (i, expression) => windows[i].webContents.executeJavaScript(expression);
  async function until(label, predicate) {
    const end = Date.now() + 20000;
    do { if (await predicate()) return; await delay(50); } while (Date.now() < end);
    throw new Error('Timeout: ' + label + ' ' + JSON.stringify(await both("({ phase: window.probe?.phase, error: window.probe?.error, level: window.probe?.measure(), text: document.body.innerText.slice(0,500) })")));
  }
  const both = expression => Promise.all(windows.map((_, i) => read(i, expression)));
  const status = "document.querySelector('.voice-stage__connection')?.textContent";
  async function audio() {
    let levels;
    await until('bidirectional playback', async () => {
      levels = await both('probe.measure()');
      return levels.every(level => level > 0.005);
    });
    return levels;
  }
  try {
    for (const user of [1, 2]) {
      const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, partition: 'voice-test-' + user } });
      win.webContents.setAudioMuted(true);
      windows.push(win);
      await win.loadURL('http://127.0.0.1:' + vite.httpServer.address().port + '/voice-test#' + user);
    }
    await until('both participants ready', async () => clients.size === 2 && (await both('!!window.probe')).every(Boolean));
    await read(0, 'probe.start()');
    await until('incoming invitation', () => read(1, "probe.phase === 'ringing'"));
    await read(1, 'probe.accept()');
    const ids = await both('probe.callId');
    assert.ok(ids[0] && ids[0] === ids[1]);
    const before = await audio();
    for (const id of [1, 2]) {
      holdOffers = true;
      clients.get(id).conn.close();
      await until('both show reconnection', async () => (await both(status)).every(value => value === 'Reconectando…'));
      await until('new media negotiation after socket reconnect', () => held.length > 0);
      await until('old audio stopped', async () => (await both('probe.measure()')).every(value => value < 0.002));
      assert.deepEqual(await both(status), ['Reconectando…', 'Reconectando…']);
      holdOffers = false;
      held.splice(0).forEach(deliver => deliver());
      const restored = await audio();
      assert.deepEqual(await both('probe.callId'), ids);
      await until('both show voice connected', async () => (await both(status)).every(value => value === 'Voz conectada'));
      console.log(JSON.stringify({ disconnectedParticipant: id, before, restored }));
    }
    await read(1, 'probe.end()');
    await until('hangup on both ends', async () => (await both('!probe.callId')).every(Boolean));
  } finally {
    windows.forEach(win => win.destroy());
    await new Promise(resolve => io.close(resolve));
    await vite.close();
  }
}
app.whenReady().then(run).then(() => app.exit(0), e => { console.error(e); app.exit(1); });
