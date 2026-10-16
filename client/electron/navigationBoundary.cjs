const { URL } = require('node:url');

function installAppNavigationBoundary(webContents, trustedDocumentURL) {
  const trustedDocument = new URL(trustedDocumentURL);

  function isTrustedDocument(destination) {
    if (typeof destination !== 'string') return false;
    try {
      const target = new URL(destination);
      return !target.username && !target.password
        && target.protocol === trustedDocument.protocol
        && target.host === trustedDocument.host
        && target.pathname === trustedDocument.pathname;
    } catch {
      return false;
    }
  }

  function blockUntrustedNavigation(event, destination, _isInPlace, isMainFrame = true) {
    // YouTube runs in a cross-origin iframe. Its own redirects must not
    // authorize replacing the app's document or opening privileged windows.
    if (isMainFrame !== false && !isTrustedDocument(destination)) event.preventDefault();
  }

  webContents.on('will-navigate', blockUntrustedNavigation);
  webContents.on('will-redirect', blockUntrustedNavigation);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { installAppNavigationBoundary };
