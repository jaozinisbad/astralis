// Invitation audio belongs to the call lifecycle, including while its dialog is
// hidden behind another view. It never captures or sends microphone audio.
const PATTERNS = {
  incoming: { repeat: 2600, level: 0.08, notes: [[660, 0, 0.18], [880, 0.23, 0.18], [660, 0.56, 0.18], [880, 0.79, 0.18]] },
  outgoing: { repeat: 4200, level: 0.035, notes: [[440, 0, 1.2], [480, 0, 1.2]] },
};

function outputSettings() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem('configuracoesAudio') || '{}');
    const volume = Number(saved?.volumeSaida ?? 100);
    return { sink: typeof saved?.foneId === 'string' ? saved.foneId : '', volume: Number.isFinite(volume) ? Math.min(2, Math.max(0, volume / 100)) : 1 };
  } catch { return { sink: '', volume: 1 }; }
}

export function createDirectCallRingtone() {
  const eventTarget = globalThis.document;
  let context = null, invitation = null, timer = null, disposed = false;
  let outputQueue = Promise.resolve();
  const nodes = new Set();

  function release(node) {
    node.oscillator.onended = null;
    try { node.oscillator.disconnect(); } catch { /* Already disconnected. */ }
    try { node.gain.disconnect(); } catch { /* Already disconnected. */ }
    nodes.delete(node);
  }

  function stop() {
    invitation = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const node of nodes) {
      try { node.oscillator.stop(); } catch { /* The scheduled note may have ended. */ }
      release(node);
    }
  }

  function ensureContext() {
    if (disposed) return null;
    if (context && context.state !== 'closed') return context;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext
      || globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
    outputQueue = Promise.resolve();
    context.onstatechange = () => { if (context?.state === 'running') void play(invitation); };
    return context;
  }

  function routeOutput(audio, session, sink) {
    // setSinkId cannot be cancelled. Serialize it so a late change from an old
    // invitation always finishes before the current invitation selects output.
    const isCurrent = () => !disposed && context === audio && invitation === session;
    outputQueue = outputQueue.catch(() => {}).then(async () => {
      if (!isCurrent() || audio.sinkId === sink) return;
      try { await audio.setSinkId(sink); }
      catch {
        // A removed headset must not turn a new call into a silent invitation.
        if (isCurrent() && sink) { try { await audio.setSinkId(''); } catch { /* Keep the current output. */ } }
      }
    });
    return outputQueue;
  }

  async function play(session) {
    if (!session || invitation !== session || disposed || context?.state !== 'running' || session.preparing || timer !== null) return;
    session.preparing = true;
    try {
      const audio = context, settings = outputSettings();
      if (typeof audio.setSinkId === 'function') await routeOutput(audio, session, settings.sink);
      if (invitation !== session || disposed || audio.state !== 'running') return;
      const pattern = PATTERNS[session.mode];
      if (settings.volume > 0) for (const [frequency, offset, duration] of pattern.notes) {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        const node = { oscillator, gain }; nodes.add(node);
        oscillator.type = 'sine';
        oscillator.connect(gain); gain.connect(audio.destination);
        const start = audio.currentTime + 0.01 + offset, end = start + duration;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(pattern.level * settings.volume, start + 0.01);
        gain.gain.setValueAtTime(pattern.level * settings.volume, end - 0.035);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.onended = () => release(node);
        oscillator.start(start); oscillator.stop(end + 0.01);
      }
      timer = setTimeout(() => { timer = null; void play(session); }, pattern.repeat);
    } catch {
      // Audio support must never prevent accepting or dismissing a call.
      stop();
    } finally { session.preparing = false; }
  }

  function unlock() {
    try {
      const audio = ensureContext();
      if (!audio) return;
      // Invoke resume in the gesture itself, before any asynchronous routing.
      const resumed = audio.state === 'running' ? undefined : audio.resume();
      void Promise.resolve(resumed).then(() => play(invitation)).catch(() => {});
    } catch { /* A browser without audio support still receives the call UI. */ }
  }

  for (const type of ['pointerdown', 'keydown', 'touchend']) eventTarget?.addEventListener?.(type, unlock, true);

  return {
    start(callId, mode) {
      if (disposed || !PATTERNS[mode]) return;
      if (invitation?.callId === callId && invitation.mode === mode) return;
      stop(); invitation = { callId, mode, preparing: false }; unlock();
    },
    stop,
    unlock,
    dispose() {
      if (disposed) return;
      disposed = true; stop();
      for (const type of ['pointerdown', 'keydown', 'touchend']) eventTarget?.removeEventListener?.(type, unlock, true);
      if (context) {
        context.onstatechange = null;
        try { void context.close()?.catch?.(() => {}); } catch { /* Already closed. */ }
        context = null;
      }
    },
  };
}
