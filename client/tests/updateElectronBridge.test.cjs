const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const electronDirectory = path.resolve(__dirname, '../electron');
const realRequire = createRequire(path.join(electronDirectory, 'main.js'));
const release = { version: '9.8.7', files: [{ url: 'Astralis-Setup-9.8.7.exe', sha512: 'test-sha', size: 1024 }] };
const updateChannels = ['obter-status-atualizacao', 'verificar-atualizacao', 'baixar-atualizacao', 'reiniciar-para-atualizar'];

async function loadMain(packaged = true) {
  const app = new EventEmitter();
  const calls = { checks: 0, downloads: 0, installs: 0, quits: 0 };
  Object.assign(app, {
    isPackaged: packaged, setName() {}, setAppUserModelId() {}, getPath: () => '/virtual-user-data',
    whenReady: () => Promise.resolve(), quit: () => { calls.quits += 1; },
  });
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => { assert.equal(handlers.has(name), false); handlers.set(name, handler); };
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const updater = new EventEmitter();
  Object.assign(updater, {
    autoDownload: true, autoInstallOnAppQuit: true,
    checkForUpdates() { calls.checks += 1; updater.emit('update-available', release); return Promise.resolve({ isUpdateAvailable: true, updateInfo: release }); },
    downloadUpdate() { calls.downloads += 1; updater.emit('update-downloaded', release); return Promise.resolve(['/virtual-cache/setup.exe']); },
    quitAndInstall() { calls.installs += 1; },
    checkForUpdatesAndNotify() { throw new Error('Automatic notification/download path must not be used'); },
  });
  const windows = [];
  class Window extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => this.messages.push(args);
      this.webContents.isDestroyed = () => this.destroyed;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    removeMenu() {}
    loadURL() {}
    loadFile() {}
  }
  const intervals = new Map();
  let timerId = 0;
  const context = {
    require(id) {
      if (id === 'electron') return {
        app, ipcMain, BrowserWindow: Window, clipboard: { writeText() {} }, desktopCapturer: {},
        session: { defaultSession: { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      };
      if (id === 'electron-updater') return { autoUpdater: updater };
      if (id === 'loopback-capture') return {};
      if (id === 'fs') return { mkdirSync() {}, appendFileSync() {} };
      return realRequire(id);
    },
    process: { platform: 'win32' }, console: { warn() {}, error() {}, log() {} }, Buffer,
    __dirname: electronDirectory,
    setInterval(callback) { const timer = { id: ++timerId, unref() {} }; intervals.set(timer, callback); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
  };
  vm.runInNewContext(readFileSync(path.join(electronDirectory, 'main.js'), 'utf8'), context, { filename: 'electron/main.js' });
  // Wait for whenReady, startup check, and the controller's check finally.
  await new Promise((resolve) => setImmediate(resolve));
  return { app, updater, calls, handlers, window: windows[0], intervals, invoke: (name) => handlers.get(name)() };
}

test('packaged main connects IPC to manual actions and keeps normal close free of installation', async () => {
  const h = await loadMain();
  for (const channel of updateChannels) assert.equal(typeof h.handlers.get(channel), 'function', channel);
  assert.equal(h.calls.checks, 1);
  assert.equal(h.calls.downloads, 0);
  assert.equal(h.calls.installs, 0);
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.invoke('obter-status-atualizacao').status, 'available');
  await h.invoke('reiniciar-para-atualizar');
  assert.equal(h.calls.installs, 0);
  await h.invoke('baixar-atualizacao');
  assert.equal(h.calls.downloads, 1);
  assert.equal(h.invoke('obter-status-atualizacao').status, 'downloaded');
  assert.equal(h.calls.installs, 0);
  h.window.emit('focus');
  for (const periodicCheck of h.intervals.values()) periodicCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.invoke('obter-status-atualizacao').status, 'downloaded');
  assert.equal(h.calls.checks, 1);
  h.window.destroyed = true;
  h.window.emit('closed');
  h.app.emit('window-all-closed');
  assert.equal(h.calls.quits, 1);
  assert.equal(h.calls.installs, 0);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.intervals.size, 0);
  for (const channel of updateChannels) assert.equal(h.handlers.has(channel), false);
});

test('packaged main invokes installation once only through the restart IPC after readiness', async () => {
  const h = await loadMain();
  await h.invoke('baixar-atualizacao');
  await h.invoke('reiniciar-para-atualizar');
  await h.invoke('reiniciar-para-atualizar');
  assert.equal(h.calls.installs, 1);
  assert.equal(h.invoke('obter-status-atualizacao').status, 'installing');
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  h.window.emit('closed');
});

test('development main exposes the same IPC without checking, downloading, or installing releases', async () => {
  const h = await loadMain(false);
  for (const channel of updateChannels) {
    assert.equal(typeof h.handlers.get(channel), 'function', channel);
    await h.invoke(channel);
  }
  assert.equal(h.calls.checks, 0);
  assert.equal(h.calls.downloads, 0);
  assert.equal(h.calls.installs, 0);
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  h.window.emit('closed');
});

test('preload update methods invoke the expected IPC channels and dispose status listeners', async () => {
  const ipcRenderer = new EventEmitter();
  const invokes = [];
  ipcRenderer.invoke = async (channel) => { invokes.push(channel); return { status: 'available' }; };
  ipcRenderer.send = () => {};
  let api;
  vm.runInNewContext(readFileSync(path.join(electronDirectory, 'preload.js'), 'utf8'), {
    require(id) {
      assert.equal(id, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, exposed) { assert.equal(name, 'electronAPI'); api = exposed; } } };
    },
    console,
  }, { filename: 'electron/preload.js' });
  assert.deepEqual(invokes, []);
  await api.obterStatusAtualizacao();
  await api.verificarAtualizacao();
  await api.baixarAtualizacao();
  await api.reiniciarParaAtualizar();
  assert.deepEqual(invokes, updateChannels);
  const received = [];
  const stopStatus = api.onAtualizacaoStatus((state) => received.push(state));
  const state = { status: 'downloaded', version: release.version };
  ipcRenderer.emit('atualizacao-status', { sender: 'native-event' }, state);
  assert.equal(received[0], state);
  stopStatus();
  ipcRenderer.emit('atualizacao-status', {}, { status: 'error' });
  assert.equal(received.length, 1);
  assert.equal(ipcRenderer.listenerCount('atualizacao-status'), 0);
  let ready = 0;
  const stopReady = api.onAtualizacaoPronta(() => { ready += 1; });
  ipcRenderer.emit('atualizacao-pronta', {});
  stopReady();
  ipcRenderer.emit('atualizacao-pronta', {});
  assert.equal(ready, 1);
  assert.equal(ipcRenderer.listenerCount('atualizacao-pronta'), 0);
});
