const LATEST_RELEASE_URL = 'https://api.github.com/repos/jaozinisbad/astralis/releases/latest';
const DOWNLOAD_BASE_URL = 'https://github.com/jaozinisbad/astralis/releases/download/';
const DEFAULT_TIMEOUT_MS = 12000;
const EXECUTABLE_TYPES = new Set([
  'application/octet-stream',
  'application/x-msdownload',
  'application/vnd.microsoft.portable-executable',
  'application/x-ms-dos-executable',
  'application/x-msdos-program',
  'application/x-dosexec',
]);
const INVALID_RELEASE_MESSAGE = 'A resposta da publicação do Astralis é inválida. Tente novamente mais tarde.';

class InstallerLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallerLookupError';
  }
}

function cancelledError(timedOut) {
  const error = new InstallerLookupError(timedOut
    ? 'A consulta do instalador demorou demais. Confira sua conexão e tente novamente.'
    : 'A busca pelo instalador foi cancelada.');
  if (!timedOut) error.name = 'AbortError';
  return error;
}

function resolveInstaller(release) {
  const tag = release?.tag_name;
  const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!release || release.draft !== false || release.prerelease !== false ||
      release.private === true || !Array.isArray(release.assets) ||
      typeof tag !== 'string' || !stableTag.test(tag)) {
    throw new InstallerLookupError(INVALID_RELEASE_MESSAGE);
  }

  const version = tag.replace(/^v/, '');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installerName = new RegExp(
    '^Astralis[- ]+Setup[- ]+' + escapedVersion + '(?:[- ]+(?:x64|ia32|arm64))?\\.exe$',
    'i',
  );
  const candidates = release.assets.filter((asset) => {
    if (!asset || asset.state !== 'uploaded' || typeof asset.name !== 'string' ||
        !installerName.test(asset.name) || typeof asset.browser_download_url !== 'string') return false;
    const contentType = typeof asset.content_type === 'string'
      ? asset.content_type.split(';')[0].trim().toLowerCase()
      : '';
    if (!EXECUTABLE_TYPES.has(contentType)) return false;
    if (asset.size !== undefined && (typeof asset.size !== 'number' || !Number.isFinite(asset.size) || asset.size <= 0)) return false;

    try {
      const url = new URL(asset.browser_download_url);
      const expectedUrl = DOWNLOAD_BASE_URL + encodeURIComponent(tag) + '/' + encodeURIComponent(asset.name);
      return /^https:\/\/github\.com\//.test(asset.browser_download_url) &&
        url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
        !url.username && !url.password && !url.search && !url.hash && url.href === expectedUrl;
    } catch {
      return false;
    }
  });

  // O instalador sem sufixo de arquitetura é o padrão produzido pelo projeto.
  // Se uma publicação tiver variantes, prefira x64 em vez de outro processador.
  const rank = (asset) => /[- ]arm64\.exe$/i.test(asset.name) ? 3
    : /[- ]ia32\.exe$/i.test(asset.name) ? 2
    : /[- ]x64\.exe$/i.test(asset.name) ? 1 : 0;
  candidates.sort((left, right) => rank(left) - rank(right));
  const asset = candidates[0];
  if (!asset) {
    throw new InstallerLookupError('A versão mais recente ainda não tem um instalador Windows válido. Tente novamente mais tarde.');
  }
  return {
    version,
    filename: asset.name,
    url: asset.browser_download_url,
    ...(typeof asset.size === 'number' ? { size: asset.size } : {}),
  };
}

// A consulta acontece somente quando o botão chama esta função.
// Nenhum import, montagem de componente ou resultado inicia o download.
export async function fetchLatestWindowsInstaller({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw cancelledError(false);
  if (typeof fetchImpl !== 'function' || typeof AbortController !== 'function') {
    throw new InstallerLookupError('Não foi possível consultar o instalador neste navegador. Recarregue a página e tente novamente.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const delay = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelledError(timedOut));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, delay);

  try {
    const lookup = (async () => {
      let response;
      try {
        response = await fetchImpl(LATEST_RELEASE_URL, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw cancelledError(timedOut);
        throw new InstallerLookupError('Não foi possível consultar o instalador. Confira sua conexão e tente novamente.');
      }

      if (response?.status === 404) {
        throw new InstallerLookupError('Ainda não há uma versão publicada do Astralis disponível para baixar.');
      }
      if (response?.status === 403 || response?.status === 429) {
        throw new InstallerLookupError('O limite de consultas ao GitHub foi atingido. Aguarde alguns minutos e tente novamente.');
      }
      if (!response || response.ok !== true || typeof response.json !== 'function') {
        throw new InstallerLookupError('Não foi possível consultar a versão mais recente do Astralis. Tente novamente mais tarde.');
      }
      const responseType = response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase();
      if (responseType && responseType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(responseType)) {
        throw new InstallerLookupError(INVALID_RELEASE_MESSAGE);
      }

      let release;
      try {
        release = await response.json();
      } catch {
        if (controller.signal.aborted) throw cancelledError(timedOut);
        throw new InstallerLookupError(INVALID_RELEASE_MESSAGE);
      }
      if (controller.signal.aborted) throw cancelledError(timedOut);
      return resolveInstaller(release);
    })();
    return await Promise.race([lookup, aborted]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
