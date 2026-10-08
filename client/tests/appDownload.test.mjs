import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLatestWindowsInstaller } from '../src/appDownload.mjs';

const endpoint = 'https://api.github.com/repos/jaozinisbad/astralis/releases/latest';
function release(version = '1.5.3') {
  const filename = 'Astralis-Setup-' + version + '.exe';
  return {
    tag_name: 'v' + version, draft: false, prerelease: false,
    html_url: 'https://github.com/jaozinisbad/astralis/releases/tag/v' + version,
    assets: [{
      name: filename, state: 'uploaded', content_type: 'application/octet-stream', size: 12345,
      browser_download_url: 'https://github.com/jaozinisbad/astralis/releases/download/v' + version + '/' + filename,
    }],
  };
}
function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}
const fetchRelease = (body) => async () => response(body);

test('finds the uploaded Windows installer through the latest endpoint without starting its download', async () => {
  const calls = [];
  const data = release();
  const result = await fetchLatestWindowsInstaller({ fetchImpl: async (...args) => { calls.push(args); return response(data); } });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0][0]), endpoint);
  assert.equal(calls[0][1].cache, 'no-store');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(result.version, '1.5.3');
  assert.equal(result.filename, 'Astralis-Setup-1.5.3.exe');
  assert.equal(result.url, data.assets[0].browser_download_url);
  assert.equal(result.size, 12345);
});

test('a later click fetches the new latest release instead of reusing an old fixed version', async () => {
  let request = 0;
  const fetchImpl = async () => response(release(++request === 1 ? '1.5.3' : '2.0.0'));
  const first = await fetchLatestWindowsInstaller({ fetchImpl });
  const second = await fetchLatestWindowsInstaller({ fetchImpl });
  assert.equal(request, 2);
  assert.equal(first.version, '1.5.3');
  assert.equal(second.version, '2.0.0');
  assert.notEqual(first.url, second.url);
  assert.match(second.url, /\/v2\.0\.0\/Astralis-Setup-2\.0\.0\.exe$/);
});

test('selects the exe among update metadata, blockmaps and other operating-system packages', async () => {
  const data = release();
  const exe = data.assets[0];
  data.assets = [
    { ...exe, name: exe.name + '.blockmap', browser_download_url: exe.browser_download_url + '.blockmap' },
    { ...exe, name: 'latest.yml', browser_download_url: exe.browser_download_url.replace(exe.name, 'latest.yml') },
    { ...exe, name: 'Astralis-1.5.3.dmg', browser_download_url: exe.browser_download_url.replace(exe.name, 'Astralis-1.5.3.dmg') },
    exe,
  ];
  assert.equal((await fetchLatestWindowsInstaller({ fetchImpl: fetchRelease(data) })).url, exe.browser_download_url);
});

test('supports the uploaded installer filename with spaces and an exact encoded asset path', async () => {
  const data = release('2.1.0');
  data.assets[0].name = 'Astralis Setup 2.1.0.exe';
  data.assets[0].browser_download_url = 'https://github.com/jaozinisbad/astralis/releases/download/v2.1.0/Astralis%20Setup%202.1.0.exe';
  assert.equal((await fetchLatestWindowsInstaller({ fetchImpl: fetchRelease(data) })).filename, 'Astralis Setup 2.1.0.exe');
});

for (const [name, mutate] of [
  ['a draft', (data) => { data.draft = true; }],
  ['a prerelease', (data) => { data.prerelease = true; }],
  ['a semver prerelease tag', (data) => { data.tag_name = 'v1.5.3-beta.1'; }],
  ['a missing release tag', (data) => { delete data.tag_name; }],
  ['an installer for another version', (data) => { data.assets[0].name = 'Astralis-Setup-1.5.2.exe'; }],
  ['a blockmap disguised as the only installer', (data) => { data.assets[0].name += '.blockmap'; }],
  ['an asset that is still being uploaded', (data) => { data.assets[0].state = 'starter'; }],
  ['an HTML asset', (data) => { data.assets[0].content_type = 'text/html'; }],
  ['an empty asset', (data) => { data.assets[0].size = 0; }],
  ['an external host', (data) => { data.assets[0].browser_download_url = 'https://downloads.example.test/Astralis-Setup-1.5.3.exe'; }],
  ['an unrelated repository', (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('/jaozinisbad/astralis/', '/other/astralis/'); }],
  ['an installer URL for another tag', (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('/v1.5.3/', '/v1.5.2/'); }],
  ['an executable URL with an unrelated name', (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('Astralis-Setup-1.5.3.exe', 'other.exe'); }],
  ['an insecure installer URL', (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('https:', 'http:'); }],
  ['a URL with credentials', (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('https://', 'https://user:password@'); }],
  ['a URL with query parameters', (data) => { data.assets[0].browser_download_url += '?redirect=other'; }],
  ['a URL with a fragment', (data) => { data.assets[0].browser_download_url += '#other'; }],
]) {
  test('refuses ' + name + ' instead of navigating to an unsafe or incorrect download', async () => {
    const data = release();
    mutate(data);
    await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: fetchRelease(data) }), /public|estável|versão|instalador|Windows|download|publicação/i);
  });
}

test('a missing release reports an actionable Portuguese error', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => response({ message: 'Not Found' }, 404) }), /publica|versão|disponível|release/i);
});

test('a GitHub rate limit reports the temporary limit without fetching an installer', async () => {
  let calls = 0;
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => {
    calls += 1;
    return response({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
  } }), /limite|solicita|tente.*(instante|novamente)|GitHub/i);
  assert.equal(calls, 1);
});

test('network failures report a Portuguese connection/retry error', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /conex|consultar|tente|GitHub/i);
});

test('a latest release without a Windows installer reports the missing package', async () => {
  const data = release();
  data.assets = [];
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: fetchRelease(data) }), /instalador|Windows|disponível/i);
});

test('invalid GitHub JSON becomes a useful error', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => ({
    ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('invalid JSON'); },
  }) }), /resposta|consultar|GitHub|tente/i);
});

function waitForAbort(_url, options) {
  return new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}
test('a slow lookup times out with an actionable error', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: waitForAbort, timeoutMs: 5 }), /tempo|demor|tente/i);
});

test('the caller can abort a pending lookup when its UI unmounts', async () => {
  const controller = new AbortController();
  const pending = fetchLatestWindowsInstaller({ fetchImpl: waitForAbort, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('an already aborted caller does not start a release lookup', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => { calls += 1; return response(release()); }, signal: controller.signal }),
    (error) => error.name === 'AbortError');
  assert.equal(calls, 0);
});

test('HTTP 429 reports a temporary GitHub limit that can be retried', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: async () => response({}, 429) }), /limite.*GitHub|aguarde.*tente/i);
});

test('the timeout finishes even if a fetch implementation ignores AbortSignal', async () => {
  await assert.rejects(fetchLatestWindowsInstaller({ fetchImpl: () => new Promise(() => {}), timeoutMs: 5 }), /demorou demais/i);
});

test('the caller can abort while the release response body is pending', async () => {
  const controller = new AbortController();
  let startedBody;
  const bodyStarted = new Promise((resolve) => { startedBody = resolve; });
  const pending = fetchLatestWindowsInstaller({
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true, status: 200, headers: new Headers(),
      json: () => { startedBody(); return new Promise(() => {}); },
    }),
  });
  await bodyStarted;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
