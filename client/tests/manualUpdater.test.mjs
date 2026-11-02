import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const electronDirectory = fileURLToPath(new URL('../electron/', import.meta.url));
const require = createRequire(import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeUpdater() {
  const updater = new EventEmitter();
  const calls = { check: 0, notifyingCheck: 0, download: 0, install: 0 };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.checkForUpdates = async () => {
    calls.check += 1;
    updater.emit('checking-for-update');
    updater.emit('update-not-available', { version: '1.5.2' });
    // O resultado da biblioteca contém objetos que não podem atravessar IPC.
    return { updateInfo: { version: '1.5.2' }, cancellationToken: { cancel() {} } };
  };
  updater.checkForUpdatesAndNotify = async () => {
    calls.notifyingCheck += 1;
    return updater.checkForUpdates();
  };
  updater.downloadUpdate = async () => { calls.download += 1; return ['update.exe']; };
  updater.quitAndInstall = () => { calls.install += 1; };
  return { updater, calls };
}

function createController(options = {}) {
  const { updater, calls } = fakeUpdater();
  const states = [];
  let clock = 10 * 60 * 1000;
  const { createManualUpdater } = require('../electron/manualUpdater.cjs');
  const controller = createManualUpdater({
    autoUpdater: updater,
    onState: (state) => states.push(state),
    now: () => clock,
    ...options,
  });
  return { updater, calls, states, controller, advance: (time) => { clock += time; } };
}

async function makeReady(fixture) {
  fixture.updater.emit('update-available', { version: '1.5.3' });
  await fixture.controller.download();
  fixture.updater.emit('update-downloaded', { version: '1.5.3' });
}

test('desliga download e instalação ao fechar antes de qualquer consulta', () => {
  const { updater, calls, controller } = createController();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, 'idle');
  assert.deepEqual(calls, { check: 0, notifyingCheck: 0, download: 0, install: 0 });
});

test('consultas de abertura, foco, período e botão nunca baixam nem instalam', async () => {
  const { calls, controller, advance } = createController();
  await controller.check('startup');
  advance(6 * 60 * 1000);
  await controller.check('focus');
  await controller.check('periodic');
  const state = await controller.check('manual', true);
  assert.equal(calls.check, 4);
  assert.equal(calls.notifyingCheck, 0);
  assert.equal(calls.download, 0);
  assert.equal(calls.install, 0);
  assert.equal(state.status, 'not-available');
  assert.deepEqual(structuredClone(state), state);
});

test('consultas simultâneas são unificadas e o foco respeita o intervalo mínimo', async () => {
  const { updater, calls, controller, advance } = createController();
  const pending = deferred();
  updater.checkForUpdates = () => { calls.check += 1; return pending.promise; };
  const first = controller.check('startup');
  const second = controller.check('manual', true);
  await Promise.resolve();
  assert.equal(calls.check, 1);
  pending.resolve({ updateInfo: { version: '1.5.2' } });
  await Promise.all([first, second]);
  await controller.check('focus');
  assert.equal(calls.check, 1);
  advance(6 * 60 * 1000);
  await controller.check('focus');
  assert.equal(calls.check, 2);
});

test('recusa baixar sem versão disponível, instalar cedo e eventos de download sem autorização', async () => {
  const { updater, calls, controller } = createController();
  await controller.download();
  controller.install();
  updater.emit('download-progress', { percent: 50 });
  updater.emit('update-downloaded', { version: '1.5.3' });
  assert.equal(controller.getState().status, 'idle');
  updater.emit('update-available', { version: '1.5.3' });
  controller.install();
  assert.equal(controller.getState().status, 'available');
  assert.equal(calls.download, 0);
  assert.equal(calls.install, 0);
});

test('descobrir versão nova só avisa; o comando de baixar inicia uma única transferência', async () => {
  const { updater, calls, controller } = createController();
  const pending = deferred();
  updater.downloadUpdate = () => { calls.download += 1; return pending.promise; };
  updater.emit('update-available', { version: '1.5.3' });
  assert.equal(controller.getState().status, 'available');
  assert.equal(calls.download, 0);

  const first = controller.download();
  const second = controller.download();
  await Promise.resolve();
  assert.equal(calls.download, 1);
  assert.equal(controller.getState().status, 'downloading');
  updater.emit('download-progress', { percent: 37.8 });
  assert.equal(controller.getState().percent, 37);
  assert.equal(controller.getState().version, '1.5.3');
  controller.install();
  assert.equal(calls.install, 0);

  updater.emit('update-downloaded', { version: '1.5.3' });
  pending.resolve(['update.exe']);
  await Promise.all([first, second]);
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(calls.install, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('consultas e eventos tardios preservam download ativo e atualização pronta', async () => {
  const { updater, calls, controller } = createController();
  const pending = deferred();
  updater.downloadUpdate = () => { calls.download += 1; return pending.promise; };
  updater.emit('update-available', { version: '1.5.3' });
  const downloading = controller.download();
  await controller.check('manual', true);
  updater.emit('checking-for-update');
  updater.emit('update-not-available', { version: '1.5.2' });
  assert.equal(controller.getState().status, 'downloading');
  assert.equal(calls.check, 0);

  updater.emit('update-downloaded', { version: '1.5.3' });
  pending.resolve(['update.exe']);
  await downloading;
  await controller.check('manual', true);
  await controller.check('periodic');
  updater.emit('checking-for-update');
  updater.emit('update-not-available', { version: '1.5.2' });
  updater.emit('update-available', { version: '1.5.4' });
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(controller.getState().version, '1.5.3');
  assert.equal(calls.install, 0);
});

test('só o comando de instalar após download reinicia; cliques repetidos são ignorados', async () => {
  const fixture = createController();
  await makeReady(fixture);
  const { updater, calls, controller } = fixture;
  assert.equal(calls.install, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
  controller.install();
  controller.install();
  assert.equal(calls.install, 1);
  assert.equal(controller.getState().status, 'installing');
});

test('erro de download permite repetir pelo comando sem nenhuma repetição automática', async () => {
  const { updater, calls, controller, advance } = createController();
  updater.emit('update-available', { version: '1.5.3' });
  updater.downloadUpdate = async () => {
    calls.download += 1;
    throw new Error('conexão interrompida');
  };
  const failed = await controller.download();
  assert.equal(failed.status, 'error');
  assert.equal(failed.errorStage, 'download');
  assert.equal(failed.version, '1.5.3');
  advance(60 * 60 * 1000);
  await controller.check('periodic');
  await controller.check('focus');
  assert.equal(calls.download, 1);
  assert.equal(calls.check, 0);

  updater.downloadUpdate = async () => {
    calls.download += 1;
    updater.emit('update-downloaded', { version: '1.5.3' });
    return ['update.exe'];
  };
  const ready = await controller.download();
  assert.equal(calls.download, 2);
  assert.equal(ready.status, 'downloaded');
  assert.equal(calls.install, 0);
});

test('erro na consulta permite nova consulta sem iniciar download', async () => {
  const { updater, calls, controller } = createController();
  updater.checkForUpdates = () => {
    calls.check += 1;
    throw new Error('sem conexão');
  };
  const failed = await controller.check('startup');
  assert.equal(failed.status, 'error');
  assert.equal(failed.errorStage, 'check');
  updater.checkForUpdates = async () => {
    calls.check += 1;
    updater.emit('update-available', { version: '1.5.3' });
    return { updateInfo: { version: '1.5.3' } };
  };
  assert.equal((await controller.check('manual', true)).status, 'available');
  assert.equal(calls.download, 0);
  assert.equal(calls.install, 0);
});

test('erro de instalação mantém versão pronta e exige novo comando para repetir', async () => {
  const fixture = createController();
  await makeReady(fixture);
  const { updater, calls, controller } = fixture;
  updater.quitAndInstall = () => {
    calls.install += 1;
    updater.emit('error', new Error('instalador indisponível'));
  };
  const failed = controller.install();
  assert.equal(failed.status, 'error');
  assert.equal(failed.errorStage, 'install');
  assert.equal(failed.version, '1.5.3');
  assert.equal(calls.install, 1);
  updater.quitAndInstall = () => { calls.install += 1; };
  controller.install();
  assert.equal(calls.install, 2);
});

test('estados enviados à interface são serializáveis e têm revisão crescente', async () => {
  const { updater, states, controller } = createController();
  await controller.check('manual', true);
  updater.emit('update-available', { version: '1.5.3' });
  await controller.download();
  updater.emit('download-progress', { percent: 199 });
  assert.equal(controller.getState().percent, 100);
  updater.emit('update-downloaded', { version: '1.5.3' });
  for (const state of states) assert.deepEqual(structuredClone(state), state);
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(states[index].revision > states[index - 1].revision);
  }
  const snapshot = controller.getState();
  snapshot.status = 'idle';
  assert.equal(controller.getState().status, 'downloaded');
});

async function loadDesktop({ packaged = true } = {}) {
  const { updater, calls } = fakeUpdater();
  const handlers = new Map();
  const intervals = new Set();
  const app = new EventEmitter();
  let appQuitCalls = 0;
  app.isPackaged = packaged;
  app.setName = () => {};
  app.setAppUserModelId = () => {};
  app.getPath = () => '/astralis-test-user-data';
  app.whenReady = () => Promise.resolve();
  app.quit = () => { appQuitCalls += 1; app.emit('quit'); };
  let win;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      win = this;
      this.messages = [];
      this.webContents = { isDestroyed: () => false, send: (...args) => this.messages.push(args) };
    }
    isDestroyed() { return false; }
    removeMenu() {}
    loadFile() {}
    loadURL() {}
  }
  const electron = {
    app,
    BrowserWindow: FakeWindow,
    clipboard: { writeText() {} },
    desktopCapturer: {},
    session: { defaultSession: {
      setDisplayMediaRequestHandler() {},
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    } },
    ipcMain: { on() {}, handle: (channel, handler) => handlers.set(channel, handler) },
  };
  const nativeRequire = createRequire(path.join(electronDirectory, 'main.js'));
  const context = {
    require(id) {
      if (id === 'electron') return electron;
      if (id === 'electron-updater') return { autoUpdater: updater };
      if (id === 'loopback-capture') return {};
      if (id === 'fs') return { mkdirSync() {}, appendFileSync() {} };
      if (id === 'child_process') return { exec: () => assert.fail('não deve executar processos neste fluxo') };
      return nativeRequire(id);
    },
    __dirname: electronDirectory,
    process: { platform: 'win32' },
    console,
    Buffer,
    setInterval(callback) { const timer = { callback, unref() {} }; intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
  };
  vm.runInNewContext(readFileSync(path.join(electronDirectory, 'main.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));

  const renderer = new EventEmitter();
  renderer.invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), 'canal IPC ausente: ' + channel);
    return Promise.resolve(handlers.get(channel)({ sender: win.webContents }, ...args));
  };
  renderer.send = () => {};
  let api;
  vm.runInNewContext(readFileSync(path.join(electronDirectory, 'preload.js'), 'utf8'), {
    require(id) {
      assert.equal(id, 'electron');
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld(name, surface) {
        assert.equal(name, 'electronAPI');
        api = surface;
      } } };
    },
    console,
  });
  return { updater, calls, api, app, win, intervals, appQuitCalls: () => appQuitCalls };
}

test('main e preload conectam os comandos; abertura, foco, período e fechamento não atualizam sozinhos', async () => {
  const desktop = await loadDesktop();
  const { updater, calls, api, app, win, intervals } = desktop;
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(calls.check, 1);
  assert.equal(calls.notifyingCheck, 0);
  win.emit('focus');
  for (const timer of intervals) timer.callback();
  await api.verificarAtualizacao();
  assert.equal(calls.download, 0);
  assert.equal(calls.install, 0);
  await api.reiniciarParaAtualizar();
  assert.equal(calls.install, 0);

  updater.emit('update-available', { version: '1.5.3' });
  assert.equal((await api.obterStatusAtualizacao()).status, 'available');
  assert.equal(calls.download, 0);
  await api.baixarAtualizacao();
  assert.equal(calls.download, 1);
  updater.emit('update-downloaded', { version: '1.5.3' });
  const ready = await api.obterStatusAtualizacao();
  assert.equal(ready.status, 'downloaded');
  assert.deepEqual(structuredClone(ready), ready);
  assert.ok(win.messages.some(([channel, state]) => channel === 'atualizacao-status' && state.status === 'downloaded'));
  assert.equal(calls.install, 0);

  win.emit('closed');
  app.emit('window-all-closed');
  assert.equal(desktop.appQuitCalls(), 1);
  assert.equal(intervals.size, 0);
  assert.equal(calls.install, 0);
});

test('preload só chama o instalador após o comando explícito da versão pronta', async () => {
  const { updater, calls, api } = await loadDesktop();
  updater.emit('update-available', { version: '1.5.3' });
  await api.baixarAtualizacao();
  updater.emit('update-downloaded', { version: '1.5.3' });
  assert.equal(calls.install, 0);
  const installing = await api.reiniciarParaAtualizar();
  assert.equal(calls.install, 1);
  assert.equal(installing.status, 'installing');
  await api.reiniciarParaAtualizar();
  assert.equal(calls.install, 1);
});


test('exceções síncronas de download e instalação também podem ser repetidas pelo usuário', async () => {
  const fixture = createController();
  const { updater, calls, controller } = fixture;
  updater.emit('update-available', { version: '1.5.3' });
  updater.downloadUpdate = () => {
    calls.download += 1;
    throw new Error('falha síncrona no download');
  };
  assert.equal((await controller.download()).errorStage, 'download');
  updater.downloadUpdate = async () => {
    calls.download += 1;
    updater.emit('update-downloaded', { version: '1.5.3' });
  };
  assert.equal((await controller.download()).status, 'downloaded');
  updater.quitAndInstall = () => {
    calls.install += 1;
    throw new Error('falha síncrona no instalador');
  };
  assert.equal(controller.install().errorStage, 'install');
  updater.quitAndInstall = () => { calls.install += 1; };
  assert.equal(controller.install().status, 'installing');
  assert.equal(calls.download, 2);
  assert.equal(calls.install, 2);
});

test('erro emitido durante download é recuperável e progresso inválido permanece limitado', async () => {
  const { updater, calls, controller } = createController();
  updater.emit('update-available', { version: '1.5.3' });
  await controller.download();
  updater.emit('download-progress', { percent: Number.NaN });
  assert.equal(controller.getState().percent, 0);
  updater.emit('download-progress', { percent: -20 });
  assert.equal(controller.getState().percent, 0);
  updater.emit('error', new Error('falha no transporte'));
  assert.equal(controller.getState().errorStage, 'download');
  assert.equal(controller.getState().canDownload, true);
  assert.equal(calls.download, 1);
  updater.downloadUpdate = async () => {
    calls.download += 1;
    updater.emit('update-downloaded', { version: '1.5.3' });
  };
  assert.equal((await controller.download()).status, 'downloaded');
  assert.equal(calls.download, 2);
  assert.equal(calls.install, 0);
});

test('a consulta iniciada antes do download não desfaz uma atualização pronta se falhar depois', async () => {
  const { updater, calls, controller } = createController();
  const pending = deferred();
  updater.checkForUpdates = () => { calls.check += 1; return pending.promise; };
  const checking = controller.check('startup');
  await Promise.resolve();
  await makeReady({ updater, controller });
  pending.reject(new Error('erro tardio na consulta'));
  await checking;
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(controller.getState().canInstall, true);
  assert.equal(calls.install, 0);
});


test('Electron em desenvolvimento mantém a ponte inativa sem consultar ou baixar atualização', async () => {
  const { api, calls, intervals } = await loadDesktop({ packaged: false });
  const initial = await api.obterStatusAtualizacao();
  assert.equal(initial.status, 'idle');
  assert.equal(initial.canDownload, false);
  assert.equal(initial.canInstall, false);
  assert.equal((await api.verificarAtualizacao()).status, 'idle');
  assert.equal((await api.baixarAtualizacao()).status, 'idle');
  assert.equal((await api.reiniciarParaAtualizar()).status, 'idle');
  assert.deepEqual(calls, { check: 0, notifyingCheck: 0, download: 0, install: 0 });
  assert.equal(intervals.size, 0);
});
