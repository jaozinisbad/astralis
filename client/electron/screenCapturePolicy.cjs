function findSelectedCaptureSource(sources, sourceId) {
  if (!Array.isArray(sources) || typeof sourceId !== 'string' || !sourceId) return null;
  return sources.find((source) => source?.id === sourceId) || null;
}

function getWindowHandleFromSourceId(sourceId) {
  const match = typeof sourceId === 'string' && sourceId.match(/^window:(\d+):\d+$/);
  if (!match || !/[1-9]/.test(match[1])) return null;
  return match[1];
}

function shouldUseSystemLoopback(request, source) {
  return Boolean(request?.audioRequested && source?.id?.startsWith('screen:'));
}

module.exports = {
  findSelectedCaptureSource,
  getWindowHandleFromSourceId,
  shouldUseSystemLoopback,
};