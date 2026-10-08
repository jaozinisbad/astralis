const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createManualUpdater } = require('../electron/manualUpdater.cjs');

const release = { version: '9.8.7', files: [{ url: 'Astralis-Setup-9.8.7.exe', sha512: 'test-sha', size: 1024 }] };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const autoUpdater = new EventEmitter();
  const calls = { check: 0, download: 0, install: [], notify: 0 };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdates = () => {
    calls.check += 1;
    if (overrides.check) return overrides.check(autoUpdater);
    announceAvailable(autoUpdater);
    return Promise.resolve({ updateInfo: release, isUpdateAvailable: true });
  };
  autoUpdater.checkForUpdatesAndNotify = () => { calls.notify += 1; throw new Error('Must never notify/download automatically'); };
  autoUpdater.downloadUpdate = () => {
    calls.download += 1;
    return overrides.download ? overrides.download(autoUpdater) : Promise.resolve(['/cache/Astralis-Setup-9.8.7.exe']);
  };
  autoUpdater.quitAndInstall = (...args) => {
    calls.install.push(args);
    return overrides.install?.(autoUpdater);
  };
  const published = [];
  const controller = createManualUpdater({ autoUpdater, publishState: (state) => published.push(state), logger: {}, now: () => 600_001 });
  return { autoUpdater, calls, published, controller };
}

function announceAvailable(autoUpdater) {
  autoUpdater.emit('update-available', release);
}

test('starts with automatic download and installation on exit disabled', () => {
  const { autoUpdater, calls, controller } = harness();
  assert.equal(controller.getState().status, 'idle');
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.deepEqual(calls, { check: 0, download: 0, install: [], notify: 0 });
  controller.dispose();
});

test('checks detect a release without downloading or installing', async () => {
  const h = harness({ check: (updater) => { announceAvailable(updater); return Promise.resolve({ updateInfo: release }); } });
  h.autoUpdater.autoDownload = true;
  h.autoUpdater.autoInstallOnAppQuit = true;
  const state = await h.controller.check('startup');
  assert.equal(state.status, 'available');
  assert.equal(state.version, release.version);
  assert.equal(h.calls.check, 1);
  assert.equal(h.calls.notify, 0);
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install.length, 0);
  assert.equal(h.autoUpdater.autoDownload, false);
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false);
  h.controller.dispose();
});

test('coalesces simultaneous release checks', async () => {
  const pending = deferred();
  const h = harness({ check: () => pending.promise });
  const first = h.controller.check('startup');
  const second = h.controller.check('manual', true);
  await Promise.resolve();
  assert.equal(h.calls.check, 1);
  announceAvailable(h.autoUpdater);
  pending.resolve({ updateInfo: release });
  await Promise.all([first, second]);
  assert.equal(h.controller.getState().status, 'available');
  h.controller.dispose();
});

test('refuses premature downloads and installation, including unsolicited downloaded events', async () => {
  const h = harness();
  await h.controller.download();
  await h.controller.install();
  h.autoUpdater.emit('download-progress', { percent: 100 });
  h.autoUpdater.emit('update-downloaded', release);
  await h.controller.install();
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install.length, 0);
  assert.notEqual(h.controller.getState().status, 'downloaded');
  h.controller.dispose();
});

test('keeps a release available until the user requests its download', async () => {
  const h = harness();
  await h.controller.check();
  for (const origin of ['focus', 'periodic', 'startup', 'manual']) await h.controller.check(origin, true);
  await h.controller.install();
  assert.equal(h.controller.getState().status, 'available');
  assert.equal(h.calls.check, 1);
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install.length, 0);
  h.controller.dispose();
});

test('downloads only after the manual call and publishes progress and readiness without installing', async () => {
  const pending = deferred();
  const h = harness({ download: () => pending.promise });
  await h.controller.check();
  const download = h.controller.download();
  await Promise.resolve();
  assert.equal(h.calls.download, 1);
  assert.equal(h.controller.getState().status, 'downloading');
  h.autoUpdater.emit('download-progress', { percent: 42.8, transferred: 428, total: 1000, bytesPerSecond: 50 });
  assert.equal(h.controller.getState().status, 'downloading');
  assert.ok(h.controller.getState().percent >= 42 && h.controller.getState().percent <= 43);
  assert.equal(h.controller.getState().version, release.version);
  h.autoUpdater.emit('update-downloaded', release);
  pending.resolve(['/cache/setup.exe']);
  await download;
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.equal(h.controller.getState().version, release.version);
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(h.calls.install.length, 0);
  h.controller.dispose();
});

test('deduplicates download and install requests and installs only on the explicit manual call', async () => {
  const pending = deferred();
  const h = harness({ download: () => pending.promise });
  await h.controller.check();
  const first = h.controller.download();
  const second = h.controller.download();
  await h.controller.install();
  assert.equal(h.calls.download, 1);
  assert.equal(h.calls.install.length, 0);
  h.autoUpdater.emit('update-downloaded', release);
  pending.resolve(['/cache/setup.exe']);
  await Promise.all([first, second]);
  h.autoUpdater.autoInstallOnAppQuit = true;
  await h.controller.install();
  await h.controller.install();
  assert.deepEqual(h.calls.install, [[false, true]]);
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(h.controller.getState().status, 'installing');
  h.controller.dispose();
});

test('does not let background checks or late events erase a downloaded release', async () => {
  const h = harness();
  await h.controller.check();
  await h.controller.download();
  assert.equal(h.controller.getState().status, 'downloaded');
  for (const origin of ['focus', 'periodic', 'manual']) await h.controller.check(origin, true);
  h.autoUpdater.emit('checking-for-update');
  h.autoUpdater.emit('update-not-available', { version: '9.8.6' });
  h.autoUpdater.emit('update-available', { ...release, version: '9.8.8' });
  h.autoUpdater.emit('download-progress', { percent: 1 });
  h.autoUpdater.emit('error', new Error('late network error'));
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.equal(h.controller.getState().version, release.version);
  assert.equal(h.calls.check, 1);
  assert.equal(h.calls.install.length, 0);
  h.controller.dispose();
});

for (const failureMode of ['throw', 'reject', 'event']) {
  test(`reports ${failureMode} check errors and retries only on a new manual request`, async () => {
    let shouldFail = true;
    const h = harness({ check: (updater) => {
      if (!shouldFail) { announceAvailable(updater); return Promise.resolve({ updateInfo: release }); }
      if (failureMode === 'throw') throw new Error('check failed');
      if (failureMode === 'event') { updater.emit('error', new Error('check failed')); return Promise.resolve(null); }
      return Promise.reject(new Error('check failed'));
    } });
    await h.controller.check('startup');
    assert.equal(h.controller.getState().status, 'error');
    assert.equal(h.controller.getState().retryAction, 'check');
    assert.equal(h.calls.check, 1);
    assert.equal(h.calls.download, 0);
    shouldFail = false;
    await h.controller.check('manual', true);
    assert.equal(h.controller.getState().status, 'available');
    assert.equal(h.calls.check, 2);
    h.controller.dispose();
  });

  test(`reports ${failureMode} download errors and preserves the manual download retry`, async () => {
    let shouldFail = true;
    const h = harness({ download: (updater) => {
      if (!shouldFail) return Promise.resolve(['/cache/setup.exe']);
      if (failureMode === 'throw') throw new Error('download failed');
      if (failureMode === 'event') { updater.emit('error', new Error('download failed')); return Promise.resolve([]); }
      return Promise.reject(new Error('download failed'));
    } });
    await h.controller.check();
    await h.controller.download();
    assert.equal(h.controller.getState().status, 'error');
    assert.equal(h.controller.getState().retryAction, 'download');
    assert.equal(h.controller.getState().version, release.version);
    assert.equal(h.calls.download, 1);
    assert.equal(h.calls.install.length, 0);
    shouldFail = false;
    await h.controller.download();
    assert.equal(h.calls.download, 2);
    assert.equal(h.controller.getState().status, 'downloaded');
    h.controller.dispose();
  });
}

test('installation errors leave the downloaded release ready for an explicit retry', async () => {
  let shouldFail = true;
  const h = harness({ install: () => { if (shouldFail) throw new Error('installer unavailable'); } });
  await h.controller.check();
  await h.controller.download();
  await h.controller.install();
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.controller.getState().retryAction, 'install');
  assert.equal(h.controller.getState().version, release.version);
  assert.equal(h.calls.install.length, 1);
  shouldFail = false;
  await h.controller.install();
  assert.equal(h.calls.install.length, 2);
  assert.equal(h.controller.getState().status, 'installing');
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false);
  h.controller.dispose();
});

test('releases update listeners on dispose and cannot perform a subsequent operation', async () => {
  const h = harness();
  assert.ok(h.autoUpdater.listenerCount('update-available') > 0);
  h.controller.dispose();
  const count = h.published.length;
  assert.equal(h.autoUpdater.listenerCount('update-available'), 0);
  assert.equal(h.autoUpdater.listenerCount('error'), 0);
  h.autoUpdater.emit('update-available', release);
  await h.controller.check();
  await h.controller.download();
  await h.controller.install();
  assert.equal(h.published.length, count);
  assert.equal(h.calls.check, 0);
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install.length, 0);
});



for (const failureMode of ['reject', 'event']) {
  test(`reports ${failureMode} installation failures with a manual install retry`, async () => {
    let shouldFail = true;
    const h = harness({ install: (updater) => {
      if (!shouldFail) return;
      if (failureMode === 'event') { updater.emit('error', new Error('installer failed')); return; }
      return Promise.reject(new Error('installer failed'));
    } });
    await h.controller.check();
    await h.controller.download();
    await h.controller.install();
    await Promise.resolve();
    assert.equal(h.controller.getState().status, 'error');
    assert.equal(h.controller.getState().retryAction, 'install');
    assert.equal(h.calls.install.length, 1);
    shouldFail = false;
    await h.controller.install();
    assert.equal(h.calls.install.length, 2);
    assert.equal(h.controller.getState().status, 'installing');
    h.controller.dispose();
  });
}

test('keeps an explicit download click received before the release check promise settles', async () => {
  const pendingCheck = deferred();
  const h = harness({ check: (updater) => { announceAvailable(updater); return pendingCheck.promise; } });
  const check = h.controller.check('startup');
  await Promise.resolve();
  assert.equal(h.controller.getState().status, 'available');
  const download = h.controller.download();
  assert.equal(h.calls.download, 0);
  pendingCheck.resolve({ updateInfo: release, isUpdateAvailable: true });
  await Promise.all([check, download]);
  assert.equal(h.calls.download, 1);
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.equal(h.calls.install.length, 0);
  h.controller.dispose();
});

test('disposing a queued check prevents native work from starting after the window closes', async () => {
  const h = harness();
  const check = h.controller.check('startup');
  h.controller.dispose();
  await check;
  assert.equal(h.calls.check, 0);
  assert.equal(h.calls.download, 0);
  assert.equal(h.calls.install.length, 0);
});

test('a downloaded event for another version cannot authorize installation', async () => {
  const pending = deferred();
  const h = harness({ download: () => pending.promise });
  await h.controller.check();
  const download = h.controller.download();
  await Promise.resolve();
  h.autoUpdater.emit('update-downloaded', { ...release, version: 'other-version' });
  assert.equal(h.controller.getState().status, 'downloading');
  await h.controller.install();
  assert.equal(h.calls.install.length, 0);
  h.autoUpdater.emit('update-downloaded', release);
  pending.resolve(['/cache/setup.exe']);
  await download;
  assert.equal(h.controller.getState().status, 'downloaded');
  h.controller.dispose();
});
