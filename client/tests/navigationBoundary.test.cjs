const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { test } = require('node:test');

const electronDirectory = path.resolve(__dirname, '../electron');
const realRequire = createRequire(path.join(electronDirectory, 'main.js'));

function loadWindow(packaged = true) {
  let window;
  class Window {
    constructor() {
      window = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
    }
    removeMenu() {}
    loadURL(url) { this.initialURL = url; }
    loadFile(file) { this.initialURL = pathToFileURL(file).href; }
  }
  const context = {
    require(id) {
      if (id === 'electron') return {
        app: {
          isPackaged: packaged, setName() {}, setAppUserModelId() {}, getPath: () => '/virtual-user-data',
          whenReady: () => new Promise(() => {}), on() {},
        },
        BrowserWindow: Window,
      };
      if (id === 'electron-updater') return { autoUpdater: {} };
      if (id === 'loopback-capture') return {};
      return realRequire(id);
    },
    process: { platform: 'win32' }, console, Buffer, __dirname: electronDirectory,
  };
  const source = readFileSync(path.join(electronDirectory, 'main.js'), 'utf8');
  vm.runInNewContext(source + '\ncreateWindow();', context);
  return window;
}

function navigationBlocked(window, eventName, url, isMainFrame = true) {
  let blocked = false;
  const event = { preventDefault() { blocked = true; } };
  window.webContents.emit(eventName, event, url, false, isMainFrame);
  return blocked;
}

for (const packaged of [true, false]) {
  test(`navigation boundary: ${packaged ? 'packaged' : 'development'} main window rejects untrusted navigation and redirects`, () => {
    const window = loadWindow(packaged);
    const externalURLs = [
      'https://attacker.invalid/attachment.html',
      'data:text/html,<script>window.attacker=true</script>',
      'javascript:window.attacker=true',
      'astralis-untrusted:payload',
      'file:///C:/Users/Public/attachment.html',
      'http://localhost:5173.attacker.invalid/',
      'http://localhost:5174/',
    ];
    for (const eventName of ['will-navigate', 'will-redirect']) {
      for (const url of externalURLs) assert.equal(navigationBlocked(window, eventName, url), true, `${eventName}: ${url}`);
    }
  });

  test(`navigation boundary: ${packaged ? 'packaged' : 'development'} trusted document retains room queries and same-document navigation`, () => {
    const window = loadWindow(packaged);
    const destination = new URL(window.initialURL);
    destination.search = '?room=room-123&code=ABCD2345';
    destination.hash = '#inicio';
    for (const eventName of ['will-navigate', 'will-redirect']) {
      assert.equal(navigationBlocked(window, eventName, destination.href), false);
    }
  });
}

test('navigation boundary: all popup requests are denied, including about:blank and trusted app URLs', () => {
  const window = loadWindow();
  assert.equal(typeof window.openHandler, 'function', 'main must install its popup boundary before loading content');
  for (const url of ['https://attacker.invalid/', 'data:text/html,test', 'about:blank', window.initialURL]) {
    assert.deepEqual(window.openHandler({ url }), { action: 'deny' });
  }
});

test('navigation boundary: YouTube subframe redirects are preserved without allowing main-window redirects', () => {
  const window = loadWindow();
  const youtube = 'https://www.youtube.com/embed/M7lc1UVf-VE?enablejsapi=1';
  assert.equal(navigationBlocked(window, 'will-redirect', youtube, false), false);
  assert.equal(navigationBlocked(window, 'will-redirect', youtube, true), true);
});
