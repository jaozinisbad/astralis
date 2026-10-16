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

function isDiscordProcessName(name) {
  return typeof name === 'string' && /^discord(?:ptb|canary|development)?(?:\.exe)?$/i.test(name);
}

function getDiscordAudioExclusionTarget(processes) {
  const discord = Array.isArray(processes)
    ? processes.filter((process) => isDiscordProcessName(process?.Name))
    : [];
  if (!discord.length) return { pid: null, reason: 'not-running' };
  const byPid = new Map(discord.map((process) => [process.ProcessId, process]));
  if (discord.some((process) => !Number.isSafeInteger(process.ProcessId) || process.ProcessId <= 0)) {
    return { pid: null, reason: 'unidentified' };
  }
  const roots = discord.filter((process) => !byPid.has(process.ParentProcessId));
  if (roots.length !== 1) return { pid: null, reason: 'multiple-roots' };
  const root = roots[0].ProcessId;
  for (const process of discord) {
    const seen = new Set();
    let current = process;
    while (current.ProcessId !== root) {
      if (seen.has(current.ProcessId)) return { pid: null, reason: 'unidentified' };
      seen.add(current.ProcessId);
      current = byPid.get(current.ParentProcessId);
      if (!current) return { pid: null, reason: 'unidentified' };
    }
  }
  return { pid: root, reason: null };
}

module.exports = {
  findSelectedCaptureSource,
  getWindowHandleFromSourceId,
  shouldUseSystemLoopback,
  isDiscordProcessName,
  getDiscordAudioExclusionTarget,
};
