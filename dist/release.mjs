export const LATEST_RELEASE_URL = 'https://api.github.com/repos/jaozinisbad/astralis/releases/latest';
const REPOSITORY_URL = 'https://github.com/jaozinisbad/astralis';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const INVALID_RELEASE = 'A publicação recebida é inválida. Tente novamente em alguns instantes.';

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

export function normalizeRelease(release) {
  const tag = release?.tag_name;
  if (!release || release.draft !== false || release.prerelease !== false ||
      typeof tag !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.test(tag) ||
      !Array.isArray(release.assets)) throw new ReleaseError(INVALID_RELEASE);
  const version = tag.replace(/^v/, '');
  const filename = `Astralis-Setup-${version}.exe`;
  const expectedURL = `${REPOSITORY_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  const asset = release.assets.find((candidate) => candidate?.name === filename &&
    candidate.state === 'uploaded' && Number.isSafeInteger(candidate.size) && candidate.size > 0 &&
    candidate.browser_download_url === expectedURL);
  if (!asset) throw new ReleaseError('A última versão ainda não tem um instalador Windows disponível. Tente novamente mais tarde.');
  const publishedAt = typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at))
    ? release.published_at : null;
  return {
    version, tag, name: typeof release.name === 'string' && release.name.trim() ? release.name : `Astralis ${version}`,
    publishedAt, notes: typeof release.body === 'string' && release.body.trim() ? release.body.trim() : 'Esta versão não possui notas de atualização.',
    url: `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}`,
    asset: { name: filename, url: expectedURL, size: asset.size },
  };
}

function abortError(timedOut) {
  const error = new ReleaseError(timedOut ? 'A consulta demorou demais. Confira sua conexão e tente novamente.' : 'A consulta foi cancelada.');
  if (!timedOut) error.name = 'AbortError';
  return error;
}

export async function fetchLatestRelease({ fetchImpl = globalThis.fetch, signal, timeoutMs = 12000 } = {}) {
  if (signal?.aborted) throw abortError(false);
  if (typeof fetchImpl !== 'function') throw new ReleaseError('Atualize seu navegador para consultar o download.');
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(timedOut));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000);
  try {
    const lookup = (async () => {
      let response;
      try {
        response = await fetchImpl(LATEST_RELEASE_URL, {
          method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
          headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw abortError(timedOut);
        throw new ReleaseError('Não foi possível consultar a versão. Confira sua conexão e tente novamente.');
      }
      if (response?.status === 403 || response?.status === 429) throw new ReleaseError('O GitHub limitou as consultas por alguns minutos. Aguarde e tente novamente.');
      if (response?.status === 404) throw new ReleaseError('Ainda não há uma versão estável disponível. Tente novamente mais tarde.');
      if (response?.ok !== true || typeof response.json !== 'function') throw new ReleaseError('Não foi possível consultar a última versão. Tente novamente.');
      let release;
      try { release = await response.json(); }
      catch {
        if (controller.signal.aborted) throw abortError(timedOut);
        throw new ReleaseError(INVALID_RELEASE);
      }
      if (controller.signal.aborted) throw abortError(timedOut);
      return normalizeRelease(release);
    })();
    return await Promise.race([lookup, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export function supportsWindowsDownload(navigatorRef = globalThis.navigator) {
  if (!navigatorRef) return false;
  const agent = navigatorRef.userAgent || '';
  if (navigatorRef.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(agent)) return false;
  return /Windows|Win32|Win64/i.test(`${navigatorRef.userAgentData?.platform || ''} ${navigatorRef.platform || ''} ${agent}`);
}

export function mountReleasePage({ documentRef = globalThis.document, windowRef = globalThis.window, fetchImpl = globalThis.fetch } = {}) {
  const all = (selector) => Array.from(documentRef.querySelectorAll(selector));
  const buttons = all('[data-download]');
  const refreshButtons = all('[data-release-refresh]');
  const labels = new Map(buttons.map((button) => [button, button.querySelector('[data-download-label]') || button]));
  const normalLabels = new Map(buttons.map((button) => [button, labels.get(button).textContent]));
  const supported = supportsWindowsDownload(windowRef.navigator);
  const lifetime = new AbortController();
  let disposed = false;
  let busy = false;
  let request = null;
  let lastLookupAt = 0;
  const write = (selector, value) => all(selector).forEach((element) => { element.textContent = value; });
  const status = (value, state = 'ready') => all('[data-release-status]').forEach((element) => {
    element.textContent = value;
    element.dataset.state = state;
  });
  function syncButtons() {
    buttons.forEach((button) => {
      button.disabled = !supported || busy;
      button.setAttribute('aria-busy', String(busy));
      labels.get(button).textContent = !supported ? 'Disponível para Windows' : busy ? 'Preparando download…' : normalLabels.get(button);
    });
    refreshButtons.forEach((button) => { button.disabled = busy; });
  }
  function render(release) {
    write('[data-release-version]', `v${release.version}`);
    write('[data-release-tag]', release.tag);
    write('[data-release-size]', `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(release.asset.size / 1024 / 1024)} MB`);
    write('[data-release-date]', release.publishedAt ? new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(release.publishedAt)) : 'Data não informada');
    all('[data-release-date]').forEach((element) => { if (release.publishedAt) element.setAttribute('datetime', release.publishedAt); });
    write('[data-release-notes]', release.notes);
    all('[data-release-link]').forEach((element) => { element.href = release.url; });
  }
  async function refresh({ forDownload = false } = {}) {
    if (disposed) return null;
    // A pending initial/background request may be reused; every later click makes a fresh lookup.
    if (!request) {
      lastLookupAt = Date.now();
      request = fetchLatestRelease({ fetchImpl, signal: lifetime.signal }).finally(() => { request = null; });
    }
    try {
      const release = await request;
      if (disposed) return null;
      render(release);
      if (!busy || forDownload) status('Última versão estável · sincronizada com o GitHub');
      return release;
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') {
        status(error.message || 'Não foi possível consultar a versão. Tente novamente.', 'error');
        if (!busy) write('[data-release-version]', 'Consulta indisponível');
      }
      return null;
    }
  }
  async function download(event) {
    event.preventDefault();
    if (disposed || busy || !supported) return;
    busy = true;
    syncButtons();
    status('Consultando o instalador mais recente…', 'loading');
    // Wait out a prior refresh, then resolve again so this click uses fresh release metadata.
    if (request) { try { await request; } catch {} }
    const release = await refresh({ forDownload: true });
    if (release && !disposed) {
      const anchor = documentRef.createElement('a');
      anchor.href = release.asset.url;
      anchor.download = release.asset.name;
      anchor.hidden = true;
      anchor.setAttribute('rel', 'noopener');
      documentRef.body.append(anchor);
      anchor.click();
      anchor.remove();
      status(`Download da ${release.tag} solicitado. Se não iniciar, clique em baixar novamente.`);
    }
    busy = false;
    syncButtons();
  }
  const refreshClick = () => { status('Consultando a última versão…', 'loading'); void refresh(); };
  const onVisibility = () => {
    if (documentRef.visibilityState === 'visible' && !busy && Date.now() - lastLookupAt >= REFRESH_INTERVAL_MS) void refresh();
  };
  buttons.forEach((button) => button.addEventListener('click', download));
  refreshButtons.forEach((button) => button.addEventListener('click', refreshClick));
  documentRef.addEventListener('visibilitychange', onVisibility);
  write('[data-platform-message], [data-platform-notice]', supported ? 'Para Windows · instalador .exe' : 'O instalador é para Windows. Acesse esta página no seu PC para baixar.');
  all('[data-platform-message], [data-platform-notice]').forEach((element) => { element.hidden = supported; });
  syncButtons();
  status('Consultando a última versão…', 'loading');
  const ready = refresh();
  const interval = windowRef.setInterval(() => {
    if (documentRef.visibilityState !== 'hidden' && !busy && Date.now() - lastLookupAt >= REFRESH_INTERVAL_MS) void refresh();
  }, REFRESH_INTERVAL_MS);
  return {
    ready, refresh,
    dispose() {
      disposed = true;
      lifetime.abort();
      windowRef.clearInterval(interval);
      buttons.forEach((button) => button.removeEventListener('click', download));
      refreshButtons.forEach((button) => button.removeEventListener('click', refreshClick));
      documentRef.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
