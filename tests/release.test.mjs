import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestRelease, normalizeRelease, supportsWindowsDownload, mountReleasePage, LATEST_RELEASE_URL } from '../dist/release.mjs';

function fixture(version = '1.7.0') {
  return {
    tag_name: `v${version}`, name: `Astralis ${version}`, published_at: '2026-10-17T20:00:00Z',
    draft: false, prerelease: false, body: 'Uma nova versão.\n<script>alert(1)</script>',
    assets: [{ name: `Astralis-Setup-${version}.exe`, state: 'uploaded', size: 90000000,
      browser_download_url: `https://github.com/jaozinisbad/astralis/releases/download/v${version}/Astralis-Setup-${version}.exe` }],
  };
}
const response = (release) => ({ ok: true, status: 200, json: async () => release });

test('metadata follows new stable releases without hardcoded version or URL', async () => {
  const calls = [];
  let latest = fixture();
  const fetchImpl = async (...args) => { calls.push(args); return response(latest); };
  assert.equal((await fetchLatestRelease({ fetchImpl })).version, '1.7.0');
  latest = fixture('8.12.30');
  const result = await fetchLatestRelease({ fetchImpl });
  assert.equal(result.version, '8.12.30');
  assert.match(result.asset.url, /v8\.12\.30\/Astralis-Setup-8\.12\.30\.exe$/);
  assert.equal(calls[0][0], LATEST_RELEASE_URL);
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].credentials, 'omit');
});

for (const [name, modify] of [
  ['draft', (r) => { r.draft = true; }],
  ['prerelease', (r) => { r.prerelease = true; }],
  ['preview version', (r) => { r.tag_name = 'v1.7.0-beta.1'; }],
  ['missing executable', (r) => { r.assets = []; }],
  ['zero bytes', (r) => { r.assets[0].size = 0; }],
  ['incomplete upload', (r) => { r.assets[0].state = 'new'; }],
  ['external download', (r) => { r.assets[0].browser_download_url = 'https://evil.test/a.exe'; }],
  ['URL query', (r) => { r.assets[0].browser_download_url += '?redirect=elsewhere'; }],
  ['wrong repository', (r) => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('/astralis/', '/elsewhere/'); }],
  ['wrong version installer', (r) => { r.assets[0].name = 'Astralis-Setup-1.6.0.exe'; }],
  ['blockmap', (r) => { r.assets[0].name += '.blockmap'; }],
]) test(`rejects ${name}`, () => {
  const release = fixture(); modify(release);
  assert.throws(() => normalizeRelease(release), { name: 'ReleaseError' });
});

test('release notes stay literal text and absent fields receive honest fallback', () => {
  assert.match(normalizeRelease(fixture()).notes, /<script>/);
  const release = fixture(); release.body = ''; release.published_at = 'bad';
  assert.equal(normalizeRelease(release).publishedAt, null);
  assert.match(normalizeRelease(release).notes, /não possui/);
});

for (const status of [403, 429, 404, 500]) test(`HTTP ${status} produces actionable error`, async () => {
  await assert.rejects(fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status }) }),
    status === 403 || status === 429 ? /limitou/ : status === 404 ? /estável/ : /Tente novamente/);
});

test('malformed JSON and network failure do not expose a stale installer', async () => {
  await assert.rejects(fetchLatestRelease({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }) }), /inválida/);
  await assert.rejects(fetchLatestRelease({ fetchImpl: async () => { throw new TypeError('private details'); } }), /conexão/);
});

test('timeout works even when fetch never observes the abort signal', async () => {
  await assert.rejects(fetchLatestRelease({ fetchImpl: () => new Promise(() => {}), timeoutMs: 5 }), /demorou/);
});

test('cancellation works before or during fetch', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchLatestRelease({ signal: controller.signal }), { name: 'AbortError' });
  const during = new AbortController();
  const request = fetchLatestRelease({ signal: during.signal, fetchImpl: () => new Promise(() => {}) });
  during.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('Windows only: mobile and other desktop operating systems receive informative state', () => {
  assert.equal(supportsWindowsDownload({ platform: 'Win32', userAgent: 'Windows NT 10.0' }), true);
  assert.equal(supportsWindowsDownload({ platform: 'Linux x86_64' }), false);
  assert.equal(supportsWindowsDownload({ platform: 'MacIntel' }), false);
  assert.equal(supportsWindowsDownload({ userAgent: 'Android Mobile', userAgentData: { platform: 'Windows', mobile: true } }), false);
});

class Element {
  constructor(text = '') { this.textContent = text; this.dataset = {}; this.attributes = {}; this.handlers = new Map(); }
  setAttribute(k, v) { this.attributes[k] = v; }
  querySelector() { return null; }
  addEventListener(k, handler) { this.handlers.set(k, handler); }
  removeEventListener(k) { this.handlers.delete(k); }
}
function page(navigator = { platform: 'Win32' }) {
  const selectors = new Map([
    ['[data-download]', [new Element('Baixar para Windows')]],
    ...['version', 'date', 'size', 'status', 'notes'].map((key) => [`[data-release-${key}]`, [new Element()]]),
    ['[data-platform-message]', [new Element()]],
  ]);
  const anchors = [];
  const handlers = new Map();
  let intervalCallback;
  const documentRef = {
    visibilityState: 'visible', querySelectorAll: (selector) => selector.split(', ').flatMap((part) => selectors.get(part) || []),
    body: { append(anchor) { anchors.push(anchor); } },
    createElement() { const a = new Element(); a.click = () => { a.clicked = true; }; a.remove = () => { a.removed = true; }; return a; },
    addEventListener: (k, h) => handlers.set(k, h), removeEventListener: (k) => handlers.delete(k),
  };
  const windowRef = { navigator, setInterval(callback, ms) { assert.equal(ms, 300000); intervalCallback = callback; return 1; }, clearInterval() {} };
  return { selectors, anchors, documentRef, windowRef, tick: () => intervalCallback(), handlers, button: selectors.get('[data-download]')[0] };
}

test('page load does not download; click rechecks latest; background refresh updates display', async () => {
  const dom = page(); let latest = fixture(); let calls = 0;
  const app = mountReleasePage({ ...dom, fetchImpl: async () => { calls++; return response(latest); } });
  await app.ready;
  assert.equal(dom.anchors.length, 0);
  assert.equal(calls, 1);
  latest = fixture('2.0.0');
  await dom.button.handlers.get('click')({ preventDefault() {} });
  assert.equal(calls, 2);
  assert.equal(dom.anchors.length, 1);
  assert.equal(dom.anchors[0].clicked, true);
  assert.match(dom.anchors[0].href, /v2\.0\.0/);
  assert.equal(dom.button.disabled, false);
  assert.equal(dom.selectors.get('[data-release-version]')[0].textContent, 'v2.0.0');
  assert.match(dom.selectors.get('[data-release-notes]')[0].textContent, /<script>/);
  latest = fixture('2.0.1');
  await app.refresh();
  assert.equal(dom.selectors.get('[data-release-version]')[0].textContent, 'v2.0.1');
  assert.equal(dom.anchors.length, 1);
  app.dispose();
});

test('failed click can be retried and cannot download previously loaded installer', async () => {
  const dom = page(); let fail = false;
  const app = mountReleasePage({ ...dom, fetchImpl: async () => fail ? { ok: false, status: 429 } : response(fixture()) });
  await app.ready; fail = true;
  await dom.button.handlers.get('click')({ preventDefault() {} });
  assert.equal(dom.anchors.length, 0);
  assert.equal(dom.button.disabled, false);
  assert.equal(dom.selectors.get('[data-release-status]')[0].dataset.state, 'error');
  fail = false;
  await dom.button.handlers.get('click')({ preventDefault() {} });
  assert.equal(dom.anchors.length, 1);
  app.dispose();
});

test('mobile displays current release but never starts an executable download', async () => {
  const dom = page({ platform: 'Linux', userAgent: 'Android Mobile' });
  const app = mountReleasePage({ ...dom, fetchImpl: async () => response(fixture()) });
  await app.ready;
  assert.equal(dom.button.disabled, true);
  await dom.button.handlers.get('click')({ preventDefault() {} });
  assert.equal(dom.anchors.length, 0);
  assert.equal(dom.selectors.get('[data-release-version]')[0].textContent, 'v1.7.0');
  assert.match(dom.selectors.get('[data-platform-message]')[0].textContent, /Windows/);
  app.dispose();
});

test('tab switching is throttled and hidden tabs do not poll', async (context) => {
  const dom = page(); let calls = 0; let now = 1000000;
  context.mock.method(Date, 'now', () => now);
  const app = mountReleasePage({ ...dom, fetchImpl: async () => { calls++; return response(fixture()); } });
  await app.ready;
  for (let i = 0; i < 20; i++) dom.handlers.get('visibilitychange')();
  assert.equal(calls, 1);
  now += 300001;
  dom.documentRef.visibilityState = 'hidden'; dom.tick();
  assert.equal(calls, 1);
  dom.documentRef.visibilityState = 'visible'; dom.handlers.get('visibilitychange')();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  app.dispose();
  assert.equal(dom.handlers.has('visibilitychange'), false);
});
