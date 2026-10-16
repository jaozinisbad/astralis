const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const electronDirectory = path.resolve(__dirname, '../electron');
const realRequire = createRequire(path.join(electronDirectory, 'main.js'));

function nativeCaptureHarness({ failFirstStart = false } = {}) {
  const handlers = new Map();
  const captures = [];
  const pendingEnumerations = [];
  const sent = [];
  const context = {
    require(id) {
      if (id === 'electron') return {
        app: { setName() {}, setAppUserModelId() {}, getPath: () => '/virtual-user-data', whenReady: () => new Promise(() => {}), on() {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        desktopCapturer: { getSources: async () => [{ id: 'window:45678:0' }] },
      };
      if (id === 'electron-updater') return { autoUpdater: {} };
      if (id === 'loopback-capture') return { LoopbackCapture: class {
        constructor() { captures.push(this); }
        start(pid, include, callback) {
          this.pid = pid; this.include = include; this.callback = callback;
          if (failFirstStart && captures.length === 1) throw new Error('Native audio initialization failed');
        }
        stop() { this.stopped = true; }
      } };
      if (id === 'child_process') return { exec(command, options, callback) {
        const encoded = command.slice(command.lastIndexOf(' ') + 1);
        const script = Buffer.from(encoded, 'base64').toString('utf16le');
        if (script.includes('Get-CimInstance')) {
          pendingEnumerations.push(() => callback(null, JSON.stringify([
            { Name: 'Discord.exe', ProcessId: 100, ParentProcessId: 1 },
          ])));
        } else callback(null, script.includes('GetWindowThreadProcessId') ? '1234' : 'Game');
      } };
      if (id === 'fs') return { readFileSync() { throw new Error('No saved preferences'); } };
      return realRequire(id);
    },
    process: { platform: 'win32' }, Buffer, console, __dirname: electronDirectory,
  };
  const source = readFileSync(path.join(electronDirectory, 'main.js'), 'utf8');
  vm.runInNewContext(source + '\nconfigurarCapturaPorProcesso(); configurarCapturaExcluindoProcesso();', context);
  const event = { sender: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
  return {
    captures, pendingEnumerations, sent,
    exclude: () => handlers.get('iniciar-captura-excluindo-processo')(event),
    window: () => handlers.get('iniciar-captura-audio-janela')(event, 'window:45678:0'),
    stop: () => handlers.get('parar-captura-processo')(event),
  };
}

test('native capture lifecycle: stopping during Discord process lookup prevents a late audio start', async () => {
  const h = nativeCaptureHarness();
  const pending = h.exclude();
  h.stop();
  h.pendingEnumerations.shift()();
  const result = await pending;
  assert.equal(result.sucesso, false);
  assert.equal(h.captures.length, 0, 'stop must invalidate the native request that is still discovering processes');
});

test('native capture lifecycle: a late desktop lookup cannot replace a newer window audio capture', async () => {
  const h = nativeCaptureHarness();
  const pending = h.exclude();
  const windowResult = await h.window();
  assert.equal(windowResult.sucesso, true);
  const windowCapture = h.captures[0];
  assert.equal(windowCapture.pid, 1234);
  h.pendingEnumerations.shift()();
  const desktopResult = await pending;
  assert.equal(desktopResult.sucesso, false);
  assert.equal(h.captures.length, 1);
  assert.notEqual(windowCapture.stopped, true, 'an obsolete lookup must leave the active capture alone');
  h.stop();
});

test('native capture lifecycle: stopped audio cannot leak queued chunks into a new capture', async () => {
  const h = nativeCaptureHarness();
  const first = h.exclude();
  h.pendingEnumerations.shift()();
  assert.equal((await first).sucesso, true);
  const obsolete = h.captures[0];
  h.stop();
  await h.window();
  obsolete.callback(Buffer.from([1, 2]));
  assert.equal(h.sent.length, 0, 'queued native callbacks from a stopped capture must be ignored');
  h.captures[1].callback(Buffer.from([3, 4]));
  assert.equal(h.sent.length, 1);
  h.stop();
});

test('native capture lifecycle: a partially started desktop capture is stopped after native initialization throws', async () => {
  const h = nativeCaptureHarness({ failFirstStart: true });
  const failed = h.exclude();
  h.pendingEnumerations.shift()();
  assert.equal((await failed).sucesso, false);
  assert.equal(h.captures[0].stopped, true, 'failed native initialization must release its allocated capture');
  assert.equal((await h.window()).sucesso, true);
  h.captures[0].callback(Buffer.from([1, 2]));
  assert.equal(h.sent.length, 0);
  h.stop();
});
