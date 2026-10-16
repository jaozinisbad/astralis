const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const electronDirectory = path.resolve(__dirname, '../electron');
const realRequire = createRequire(path.join(electronDirectory, 'main.js'));

function loadAudioHandlers(processName, processes = []) {
  const handlers = new Map();
  const starts = [];
  const context = {
    require(id) {
      if (id === 'electron') return {
        app: { setName() {}, setAppUserModelId() {}, getPath: () => '/virtual-user-data', whenReady: () => new Promise(() => {}), on() {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        desktopCapturer: { getSources: async () => [{ id: 'window:45678:0' }] },
      };
      if (id === 'electron-updater') return { autoUpdater: {} };
      if (id === 'loopback-capture') return { LoopbackCapture: class {
        start(...args) { starts.push(args); }
        stop() {}
      } };
      if (id === 'child_process') return { exec(command, options, callback) {
        const encoded = command.slice(command.lastIndexOf(' ') + 1);
        const script = Buffer.from(encoded, 'base64').toString('utf16le');
        const output = script.includes('GetWindowThreadProcessId') ? '1234'
          : script.includes('Get-CimInstance') ? JSON.stringify(processes) : processName;
        callback(null, output);
      } };
      if (id === 'fs') return { readFileSync() { throw new Error('No saved preferences'); } };
      return realRequire(id);
    },
    process: { platform: 'win32' }, Buffer, console, __dirname: electronDirectory,
  };
  const source = readFileSync(path.join(electronDirectory, 'main.js'), 'utf8');
  vm.runInNewContext(source + '\nconfigurarCapturaPorProcesso(); configurarCapturaExcluindoProcesso();', context);
  const event = { sender: { isDestroyed: () => false, send() {} } };
  return {
    starts,
    capture: () => handlers.get('iniciar-captura-audio-janela')(event, 'window:45678:0'),
    exclude: () => handlers.get('iniciar-captura-excluindo-processo')(event, 'UnrelatedApp.exe'),
  };
}

test('selected Discord windows stay silent before any process audio capture starts', async () => {
  for (const name of ['Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment', '']) {
    const h = loadAudioHandlers(name);
    const result = await h.capture();
    assert.equal(result.sucesso, false, name);
    assert.equal(h.starts.length, 0, name);
    assert.match(result.mensagem, /Discord.*sem áudio/);
  }
});

test('a selected game still captures only its own verified process tree', async () => {
  const h = loadAudioHandlers('Game');
  const result = await h.capture();
  assert.equal(result.sucesso, true);
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0][0], 1234);
  assert.equal(h.starts[0][1], true);
});

test('desktop exclusion supports a single Canary tree and ignores caller-supplied executable names', async () => {
  const h = loadAudioHandlers('', [
    { Name: 'DiscordCanary.exe', ProcessId: 100, ParentProcessId: 1 },
    { Name: 'DiscordCanary.exe', ProcessId: 101, ParentProcessId: 100 },
  ]);
  const result = await h.exclude();
  assert.equal(result.sucesso, true);
  assert.equal(h.starts[0][0], 100);
  assert.equal(h.starts[0][1], false);
});

test('desktop capture sends no audio when Discord instances cannot share one excluded process tree', async () => {
  for (const processes of [[], [
    { Name: 'Discord.exe', ProcessId: 100, ParentProcessId: 1 },
    { Name: 'DiscordPTB.exe', ProcessId: 200, ParentProcessId: 1 },
  ], [
    { Name: 'Discord.exe', ProcessId: 100, ParentProcessId: 1 },
    { Name: 'Discord.exe', ProcessId: 200, ParentProcessId: 1 },
  ]]) {
    const h = loadAudioHandlers('', processes);
    const result = await h.exclude();
    assert.equal(result.sucesso, false);
    assert.equal(h.starts.length, 0);
    assert.match(result.mensagem, /Discord.*sem áudio/);
  }
});
