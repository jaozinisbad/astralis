// A consulta pode ser automática; baixar e instalar exigem ações distintas.
function createManualUpdater({ autoUpdater, onState = () => {}, logger = {}, now = Date.now }) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let state = { status: 'idle', message: '', revision: 0, canDownload: false, canInstall: false };
  let lastCheck = null;
  let checkPromise = null;
  let downloadPromise = null;
  let downloadAuthorized = false;
  let downloadedVersion = null;

  const getState = () => ({ ...state });
  const isPending = () => ['downloading', 'downloaded', 'installing'].includes(state.status)
    || (state.status === 'error' && state.errorStage === 'install');

  function publish(status, message, details = {}) {
    state = {
      status,
      message,
      revision: state.revision + 1,
      canDownload: status === 'available' || (status === 'error' && details.errorStage === 'download'),
      canInstall: status === 'downloaded' || (status === 'error' && details.errorStage === 'install'),
      ...details,
    };
    logger.info?.('Atualização: ' + status + ': ' + message);
    onState(getState());
    return getState();
  }

  function fail(stage, error) {
    logger.error?.(error);
    const messages = {
      check: 'Não foi possível verificar atualizações. Confira a conexão e tente novamente.',
      download: 'Não foi possível baixar a atualização. Você pode continuar usando o Astralis e tentar novamente.',
      install: 'Não foi possível reiniciar para instalar. Tente novamente quando quiser.',
    };
    return publish('error', messages[stage], {
      errorStage: stage,
      ...(state.version ? { version: state.version } : {}),
      detail: error?.message || String(error),
    });
  }

  autoUpdater.on('checking-for-update', () => {
    if (!isPending() && state.status !== 'checking') publish('checking', 'Verificando atualizações…');
  });
  autoUpdater.on('update-available', (info) => {
    if (isPending()) return;
    publish('available', 'Atualização ' + info.version + ' disponível. Baixe quando quiser.', { version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    if (isPending()) return;
    publish('not-available', 'O Astralis está atualizado.', { version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!downloadAuthorized || state.status !== 'downloading') return;
    const rawPercent = Number(progress.percent);
    const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.floor(rawPercent))) : 0;
    publish('downloading', 'Baixando atualização: ' + percent + '%. Você pode continuar usando o Astralis.', {
      version: state.version,
      percent,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (!downloadAuthorized || state.status !== 'downloading') return;
    downloadAuthorized = false;
    downloadedVersion = info.version || state.version;
    publish('downloaded', 'Atualização ' + downloadedVersion + ' pronta. Reinicie e instale quando quiser.', {
      version: downloadedVersion,
      percent: 100,
    });
  });
  autoUpdater.on('error', (error) => {
    if (state.status === 'installing') {
      fail('install', error);
    } else if (downloadAuthorized) {
      downloadAuthorized = false;
      fail('download', error);
    } else if (!isPending() && state.status !== 'error') {
      fail('check', error);
    }
  });

  function check(origin = 'manual', force = false) {
    if (isPending() || downloadPromise) return Promise.resolve(getState());
    if (checkPromise) return checkPromise;
    if (!force && (state.canDownload || (origin === 'focus' && lastCheck !== null && now() - lastCheck < 5 * 60 * 1000))) {
      return Promise.resolve(getState());
    }

    lastCheck = now();
    logger.info?.('Verificando atualizações (' + origin + ').');
    publish('checking', 'Verificando atualizações…');
    // A microtask também captura exceções síncronas e impede consultas duplicadas.
    checkPromise = Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .catch((error) => {
        if (!isPending() && !(state.status === 'error' && state.errorStage === 'check')) fail('check', error);
      })
      .then(() => getState())
      .finally(() => { checkPromise = null; });
    return checkPromise;
  }

  function download() {
    if (downloadPromise) return downloadPromise;
    if (!state.canDownload) return Promise.resolve(getState());

    downloadAuthorized = true;
    publish('downloading', 'Baixando atualização: 0%. Você pode continuar usando o Astralis.', {
      version: state.version,
      percent: 0,
    });
    downloadPromise = Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .catch((error) => {
        downloadAuthorized = false;
        if (state.status !== 'downloaded' && !(state.status === 'error' && state.errorStage === 'download')) fail('download', error);
      })
      .then(() => getState())
      .finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  function install() {
    if (!state.canInstall || !downloadedVersion) return getState();
    publish('installing', 'Reiniciando o Astralis para instalar a atualização…', { version: downloadedVersion });
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      fail('install', error);
    }
    return getState();
  }

  return { getState, check, download, install };
}

module.exports = { createManualUpdater };
