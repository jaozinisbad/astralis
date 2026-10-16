const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const electronDirectory = path.resolve(__dirname, '../electron');
const realRequire = createRequire(path.join(electronDirectory, 'main.js'));

async function loadCompatibilityMain() {
  const calls = { writes: [], relaunches: [], exits: [], timers: [] };
  const handlers = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, setName() {}, setAppUserModelId() {},
    getPath: () => '/virtual-user-data', whenReady: () => Promise.resolve(),
    commandLine: { getSwitchValue: () => 'AllowWgcScreenCapturer,FeatureOne', appendSwitch() {} },
    relaunch: (options) => calls.relaunches.push(options), exit: (code) => calls.exits.push(code),
  });
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = { send() {}, isDestroyed: () => false }; }
    isDestroyed() { return false; }
    removeMenu() {}
    loadURL() {}
  }
  const context = {
    require(id) {
      if (id === 'electron') return {
        app, BrowserWindow: Window, clipboard: {}, desktopCapturer: {},
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
        session: { defaultSession: { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      };
      if (id === 'electron-updater') return { autoUpdater: {} };
      if (id === 'loopback-capture') return {};
      if (id === './navigationBoundary.cjs') return { installAppNavigationBoundary() {} };
      if (id === './manualUpdater.cjs') return { createManualUpdater: () => ({ getState: () => ({}), dispose() {} }) };
      if (id === 'fs') return {
        readFileSync: () => '{"usarGdi":true}', mkdirSync() {}, appendFileSync() {},
        writeFileSync: (file, data) => calls.writes.push({ file, data }), renameSync() {},
      };
      return realRequire(id);
    },
    process: {
      platform: 'win32', pid: 42, getSystemVersion: () => '10.0.19045',
      argv: ['Astralis.exe', '--disable-features=AllowWgcScreenCapturer,AllowWgcWindowCapturer,FeatureOne', '--lang=pt-BR'],
    },
    __dirname: electronDirectory, Buffer, console,
    setTimeout: (callback) => { calls.timers.push(callback); },
  };
  vm.runInNewContext(readFileSync(path.join(electronDirectory, 'main.js'), 'utf8'), context, { filename: 'electron/main.js' });
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, invoke: (name, ...args) => handlers.get(name)({}, ...args) };
}

test('turning legacy window capture off persists the choice and relaunches without its stale command-line feature', async () => {
  const h = await loadCompatibilityMain();
  assert.equal(h.invoke('obter-compatibilidade-captura-janela').enabled, true);
  const result = h.invoke('aplicar-compatibilidade-captura-janela', false);
  assert.equal(result.ok, true);
  assert.equal(result.alterada, true);
  assert.deepEqual(JSON.parse(h.calls.writes[0].data), { usarGdi: false });
  assert.equal(h.calls.relaunches.length, 0);
  assert.equal(h.calls.exits.length, 0);
  h.calls.timers[0]();
  assert.deepEqual(Array.from(h.calls.relaunches[0].args), [
    '--disable-features=AllowWgcScreenCapturer,FeatureOne', '--lang=pt-BR',
  ]);
  assert.deepEqual(h.calls.exits, [0]);
});

test('reading or keeping the active legacy capture choice never schedules an app restart', async () => {
  const h = await loadCompatibilityMain();
  assert.equal(h.invoke('obter-compatibilidade-captura-janela').enabled, true);
  assert.equal(h.invoke('aplicar-compatibilidade-captura-janela', true).alterada, false);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.timers.length, 0);
  assert.equal(h.calls.relaunches.length, 0);
  assert.equal(h.calls.exits.length, 0);
});
