const FOCUS_CHECK_INTERVAL = 5 * 60 * 1000;

// Nenhum evento do updater concede autorização para baixar ou instalar.
// Essa autorização só vem dos métodos chamados pelos botões do aplicativo.
function createManualUpdater({ autoUpdater, publishState = () => {}, logger = console, now = Date.now }) {
  let state = { status: 'idle', message: '' };
  let disposed = false;
  let lastCheck = -Infinity;
  let activeCheck = null;
  let activeDownload = null;
  let operation = null;
  let authorizedVersion = null;
  let readyVersion = null;
  const listeners = [];

  function enforceManualPolicy() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }
  enforceManualPolicy();

  function getState() {
    return { ...state };
  }

  function log(level, ...values) {
    try { logger?.[level]?.(...values); } catch {}
  }

  function publish(status, message, details = {}) {
    if (disposed) return;
    state = { status, message, ...details };
    log('info', 'Updater state:', state);
    try { publishState(getState()); } catch (error) { log('error', error); }
  }

  function fail(error, kind = operation?.kind || (state.status === 'error' ? state.retryAction : 'check'), expectedOperation = operation) {
    log('error', error);
    if (disposed || (expectedOperation && expectedOperation !== operation)) return;
    // Eventos atrasados de uma consulta/download não descartam o instalador pronto.
    if (state.status === 'downloaded' || state.status === 'installing' && kind !== 'install') return;
    if (expectedOperation?.failed) return;
    if (expectedOperation) expectedOperation.failed = true;
    const messages = {
      check: 'Não consegui verificar atualizações. Confira a conexão e tente novamente.',
      download: 'Não consegui baixar a atualização. Confira a conexão e tente novamente.',
      install: 'Não consegui iniciar a instalação. Tente reiniciar para atualizar novamente.',
    };
    publish('error', messages[kind], {
      ...(state.version ? { version: state.version } : {}),
      retryAction: kind,
      detail: error?.message || String(error),
    });
  }

  function on(event, listener) {
    autoUpdater.on(event, listener);
    listeners.push([event, listener]);
  }

  function isCurrent(op) {
    return !disposed && operation === op && !op.failed;
  }

  function available(info) {
    if (!operation || operation.kind !== 'check' || operation.failed || state.status !== 'checking') return;
    if (typeof info?.version !== 'string' || !info.version) {
      fail(new Error('A publicação não informou uma versão válida.'), 'check', operation);
      return;
    }
    publish('available', 'Atualização ' + info.version + ' disponível. Baixe quando quiser.', { version: info.version });
  }

  function notAvailable(info) {
    if (!operation || operation.kind !== 'check' || operation.failed || state.status !== 'checking') return;
    publish('not-available', 'O Astralis está atualizado.', {
      ...(typeof info?.version === 'string' ? { version: info.version } : {}),
    });
  }

  function downloaded(info) {
    if (disposed || !authorizedVersion || readyVersion || ![
      'downloading',
      'error',
    ].includes(state.status)) return;
    if (state.status === 'error' && state.retryAction !== 'download') return;
    if (info?.version && info.version !== authorizedVersion) return;
    readyVersion = authorizedVersion;
    publish('downloaded', 'Atualização ' + readyVersion + ' pronta. Reinicie para instalar quando quiser.', {
      version: readyVersion,
      percent: 100,
    });
  }

  on('checking-for-update', () => {
    // check() publica o estado antes de consultar. Não aceite eventos externos/tardios.
  });
  on('update-available', available);
  on('update-not-available', notAvailable);
  on('download-progress', (progress) => {
    if (disposed || !operation || operation.kind !== 'download' || operation.failed || state.status !== 'downloading') return;
    const value = Number(progress?.percent);
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 0;
    publish('downloading', 'Baixando atualização: ' + percent + '%.', { version: authorizedVersion, percent });
  });
  on('update-downloaded', downloaded);
  on('error', (error) => {
    if (disposed) return;
    fail(error);
  });

  function check(origin = 'manual', force = false) {
    enforceManualPolicy();
    if (disposed) return Promise.resolve(getState());
    if (activeCheck) return activeCheck;
    if (activeDownload || ['available', 'downloading', 'downloaded', 'installing'].includes(state.status) ||
        state.status === 'error' && state.retryAction !== 'check') return Promise.resolve(getState());
    const currentTime = now();
    if (!force && origin === 'focus' && currentTime - lastCheck < FOCUS_CHECK_INTERVAL) return Promise.resolve(getState());
    lastCheck = currentTime;
    const op = { kind: 'check', failed: false };
    operation = op;
    log('info', 'Checking for updates (' + origin + ').');
    publish('checking', 'Verificando atualizações…');
    activeCheck = Promise.resolve()
      .then(() => disposed ? null : autoUpdater.checkForUpdates())
      .then((result) => {
        if (isCurrent(op) && state.status === 'checking') {
          if (result?.isUpdateAvailable) available(result.updateInfo);
          else notAvailable(result?.updateInfo);
        }
        return getState();
      })
      .catch((error) => {
        fail(error, 'check', op);
        return getState();
      })
      .finally(() => {
        if (operation === op) operation = null;
        activeCheck = null;
      });
    return activeCheck;
  }

  function download() {
    enforceManualPolicy();
    if (disposed) return Promise.resolve(getState());
    if (activeDownload) return activeDownload;
    if (state.status !== 'available' && !(state.status === 'error' && state.retryAction === 'download')) {
      return Promise.resolve(getState());
    }
    // O aviso pode chegar um instante antes da Promise da consulta terminar.
    // Preserve esse clique, mas aguarde a consulta terminar antes de baixar.
    activeDownload = Promise.resolve(activeCheck).then(async () => {
      if (disposed || state.status !== 'available' && !(state.status === 'error' && state.retryAction === 'download')) return getState();
      const op = { kind: 'download', failed: false };
      operation = op;
      authorizedVersion = state.version;
      publish('downloading', 'Baixando atualização: 0%.', { version: authorizedVersion, percent: 0 });
      try {
        enforceManualPolicy();
        const files = await autoUpdater.downloadUpdate();
        if (isCurrent(op) && state.status === 'downloading' && Array.isArray(files) && files.length) {
          downloaded({ version: authorizedVersion });
        }
      } catch (error) {
        fail(error, 'download', op);
      } finally {
        if (operation === op) operation = null;
      }
      return getState();
    }).finally(() => {
      activeDownload = null;
    });
    return activeDownload;
  }

  function install() {
    enforceManualPolicy();
    if (disposed || !readyVersion || state.status !== 'downloaded' && !(state.status === 'error' && state.retryAction === 'install')) return getState();
    const op = { kind: 'install', failed: false };
    operation = op;
    publish('installing', 'Reiniciando o Astralis para instalar a atualização…', { version: readyVersion });
    try {
      // Chamado exclusivamente pelo botão de reiniciar. Fechar normalmente não instala.
      const result = autoUpdater.quitAndInstall(false, true);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => fail(error, 'install', op));
      }
    } catch (error) {
      fail(error, 'install', op);
    }
    return getState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [event, listener] of listeners) autoUpdater.removeListener(event, listener);
  }

  return { getState, check, download, install, dispose };
}

module.exports = { createManualUpdater };
