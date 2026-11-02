// Explicit native validation only: electron tests/voiceAudio.native.cjs <result.json>
// Uses temporary Electron/Vite profiles, synthetic input and in-memory signaling.
// Observed output goes through a zero-gain sink to avoid playing test tones.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'astralis-voice-audio-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const output = process.argv[2];
let vite, window;
const watchdog = setTimeout(() => { console.error('Native voice/audio validation timed out'); app.exit(1); }, 120_000);

async function browserRun() {
  const [{ default: React }, { createRoot }, { default: VoiceChannel }, { createDirectCallRingtone }] = await Promise.all([
    import('react'), import('react-dom/client'), import('/src/components/VoiceChannel.jsx'), import('/src/directCallRingtone.mjs'),
  ]);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) { if (predicate()) return; await wait(25); }
    throw new Error(`Timed out: ${label}; ${JSON.stringify(globalThis.nativeAudioDebug?.() || {})}`);
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)));
  const NativeAudioContext = globalThis.AudioContext;
  const NativeAudio = globalThis.Audio;
  const NativePeer = globalThis.RTCPeerConnection;
  const contexts = [], audioRecords = [], peers = [], roots = [], generated = [];
  let currentOwner = null;
  const withOwner = (owner, action) => {
    const previous = currentOwner; currentOwner = owner;
    try { return action(); } finally { currentOwner = previous; }
  };
  const rms = analyser => {
    if (!analyser || analyser.context.state === 'closed') return 0;
    const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  };
  class ObservedAudioContext extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      const destination = super.destination;
      const analyser = this.createAnalyser(); analyser.fftSize = 2048;
      const silent = this.createGain(); silent.gain.value = 0;
      analyser.connect(silent).connect(destination);
      Object.defineProperty(this, 'destination', { value: analyser });
      this.observedOutput = analyser; contexts.push(this);
    }
  }
  globalThis.AudioContext = ObservedAudioContext;
  globalThis.Audio = function (...args) {
    const element = new NativeAudio(...args);
    const context = new NativeAudioContext();
    const source = context.createMediaElementSource(element);
    const analyser = context.createAnalyser(); analyser.fftSize = 4096;
    const silent = context.createGain(); silent.gain.value = 0;
    source.connect(analyser).connect(silent).connect(context.destination);
    const record = { owner: currentOwner, element, context, analyser };
    audioRecords.push(record); void context.resume();
    return element;
  };
  globalThis.Audio.prototype = NativeAudio.prototype;
  class LocalPeer extends NativePeer {
    constructor(config) { super({ ...config, iceServers: [] }); this.owner = currentOwner; peers.push(this); }
    set ontrack(listener) { super.ontrack = event => withOwner(this.owner, () => listener(event)); }
  }
  globalThis.RTCPeerConnection = LocalPeer;
  const makeTone = frequency => {
    const context = new NativeAudioContext();
    const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination(), analyser = context.createAnalyser();
    const silent = context.createGain(); silent.gain.value = 0;
    oscillator.frequency.value = frequency; gain.gain.value = 0.2;
    oscillator.connect(gain).connect(analyser).connect(destination); analyser.connect(silent).connect(context.destination); oscillator.start(); void context.resume();
    generated.push({ context, oscillator, stream: destination.stream, analyser });
    return destination.stream;
  };
  const micQueue = [makeTone(330), makeTone(550)];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    const stream = micQueue.shift(); check(stream, 'Unexpected microphone request'); return stream;
  } });
  localStorage.setItem('configuracoesAudio', JSON.stringify({ perfilEntrada: 'estudio', supressaoRuido: 'desligada', volumeSaida: 100 }));

  const sockets = new Map(), members = new Set(), deferred = [];
  let pauseSignaling = true;
  class Socket {
    constructor(id) { this.id = id; this.connected = true; this.listeners = new Map(); sockets.set(id, this); }
    on(event, listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(listener); }
    off(event, listener) { if (listener) this.listeners.get(event)?.delete(listener); else this.listeners.delete(event); }
    receive(event, data) {
      for (const listener of this.listeners.get(event) || []) {
        try { const promise = withOwner(this.id, () => listener(data)); promise?.catch?.(error => errors.push(String(error.stack || error))); }
        catch (error) { errors.push(String(error.stack || error)); }
      }
    }
    emit(event, data) {
      if (event === 'entrar-canal-voz') {
        const existing = [...members].filter(id => id !== this.id).map(socketId => ({ socketId, nome: socketId }));
        members.add(this.id);
        queueMicrotask(() => this.receive('peers-existentes', { peers: existing }));
        for (const peer of existing) queueMicrotask(() => sockets.get(peer.socketId).receive('novo-peer', { socketId: this.id, nome: this.id }));
      } else if (event.startsWith('webrtc-')) {
        const deliver = () => sockets.get(data.para)?.receive(event, { ...data, de: this.id });
        if (pauseSignaling) deferred.push(deliver); else queueMicrotask(deliver);
      } else if (event === 'tela-parada' || event === 'sair-canal-voz') {
        if (event === 'sair-canal-voz') members.delete(this.id);
        for (const id of members) if (id !== this.id) queueMicrotask(() => sockets.get(id)?.receive(event === 'tela-parada' ? event : 'peer-saiu', { socketId: this.id }));
      }
    }
  }
  const mounts = {};
  const mount = async id => {
    const holder = document.createElement('div'); holder.dataset.peer = id; document.body.append(holder);
    const root = createRoot(holder), ref = React.createRef(), socket = new Socket(id), entry = { root, ref, holder, state: null };
    roots.push(root); mounts[id] = entry;
    root.render(React.createElement(VoiceChannel, { ref, socket, canal: { id: 'direta:native-test', nome: 'Teste privado local', direta: true }, nomeUsuario: id, visible: true,
      onEstadoChange: state => { entry.state = state; }, onCompartilharTela() {} }));
    await until(() => entry.state?.connectionState === 'connected' && ref.current, `${id} connected`);
    return entry;
  };
  const trackRms = record => {
    if (record.element.srcObject && record.rawStream !== record.element.srcObject) {
      record.rawSource?.disconnect();
      record.rawSource = record.context.createMediaStreamSource(record.element.srcObject);
      record.rawAnalyser = record.context.createAnalyser();
      record.rawAnalyser.fftSize = 4096;
      const silent = record.context.createGain(); silent.gain.value = 0;
      record.rawSource.connect(record.rawAnalyser).connect(silent).connect(record.context.destination);
      record.rawStream = record.element.srcObject;
    }
    return rms(record.rawAnalyser);
  };
  const snapshot = record => ({ owner: record.owner, contextState: record.context.state, muted: record.element.muted, volume: record.element.volume,
    paused: record.element.paused, readyState: record.element.readyState, rms: rms(record.analyser),
    remoteTrackRms: trackRms(record),
    trackKinds: record.element.srcObject?.getTracks().map(track => track.kind) || [] });
  globalThis.nativeAudioDebug = () => ({ generated: generated.map(item => ({ state: item.context.state, rms: rms(item.analyser) })), audio: audioRecords.map(snapshot), states: Object.fromEntries(Object.entries(mounts).map(([id, entry]) => [id, entry.state])), peerConnections: peers.map(peer => ({ owner: peer.owner, state: peer.connectionState })) });
  const peak = async (analyser, duration = 250) => {
    let maximum = 0; const deadline = performance.now() + duration;
    while (performance.now() < deadline) { maximum = Math.max(maximum, rms(analyser)); await wait(20); }
    return maximum;
  };
  const result = { method: 'Native Chromium RTCPeerConnection + real VoiceChannel; playback RMS from createMediaElementSource -> AnalyserNode before a test-only zero-gain sink',
    autoplayPolicy: 'no-user-gesture-required (isolates media policy; browser gesture fallback is covered by unit tests)',
    signaling: 'in-memory only; RTC iceServers=[]; no production services', snapshots: {}, ringtone: {} };
  let drawing;
  try {
    const a = await mount('sender');
    a.ref.current.alternarAudio();
    await until(() => a.state.audioMudo, 'sender deafened before starting screen capture');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const drawingContext = canvas.getContext('2d'); let frame = 0;
    const draw = () => { drawingContext.fillStyle = frame++ % 2 ? '#275599' : '#994422'; drawingContext.fillRect(0, 0, canvas.width, canvas.height); };
    draw(); drawing = setInterval(draw, 1000 / 60);
    const screen = canvas.captureStream(60); const screenTone = makeTone(1100);
    screen.addTrack(screenTone.getAudioTracks()[0]);
    await a.ref.current.iniciarCompartilhamento({ stream: screen, shareAudio: true });
    const b = await mount('viewer');
    b.ref.current.alternarAudio();
    await until(() => b.state.audioMudo, 'viewer deafened before first remote tracks');
    pauseSignaling = false; deferred.splice(0).forEach(deliver => queueMicrotask(deliver));
    await until(() => audioRecords.filter(record => record.owner === 'viewer' && record.element.srcObject).length === 2 && b.state.telasAtivas.includes('sender'), 'distinct remote voice/screen tracks');
    const viewerAudios = audioRecords.filter(record => record.owner === 'viewer' && record.element.srcObject);
    const streamAudio = viewerAudios.find(record => record.element.srcObject.getVideoTracks().length);
    const voiceAudio = viewerAudios.find(record => record !== streamAudio);
    check(streamAudio && voiceAudio && streamAudio !== voiceAudio, 'Voice and stream must have distinct native playback elements');
    b.ref.current.alternarTransmissao('sender');
    await until(() => b.state.telaSelecionadaId === 'sender', 'screen selected');
    await Promise.all(viewerAudios.map(record => record.element.play()));
    await until(() => trackRms(streamAudio) > 0.005 && !streamAudio.element.muted, 'screen signal received while both peers are deafened');
    check(voiceAudio.element.muted, 'New remote voice must respect existing deafen');
    result.snapshots.joinedWhileDeafened = { voice: snapshot(voiceAudio), screen: snapshot(streamAudio) };
    const video = b.holder.querySelector('video');
    await until(() => video?.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 10, 'native video decoded');
    const attached = video.srcObject, assignmentDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    let redundantAssignments = 0;
    Object.defineProperty(video, 'srcObject', { configurable: true, get() { return assignmentDescriptor.get.call(this); }, set(value) { redundantAssignments++; assignmentDescriptor.set.call(this, value); } });

    a.ref.current.alternarMudo();
    await until(() => a.state.micMudo, 'sender microphone muted');
    await wait(350);
    check(await peak(streamAudio.rawAnalyser) > 0.005, 'Sender microphone mute must preserve screen audio transport');
    b.ref.current.alternarAudio();
    await until(() => !b.state.audioMudo, 'voice deafen disabled');
    await wait(400);
    result.snapshots.senderMicMuted = { voice: snapshot(voiceAudio), screen: snapshot(streamAudio) };
    check(await peak(voiceAudio.rawAnalyser) < 0.002, 'Muted sender microphone must arrive silent');
    a.ref.current.alternarMudo();
    await until(() => !a.state.micMudo, 'sender microphone unmuted');
    await until(() => trackRms(voiceAudio) > 0.005, 'native voice audio resumed');
    const screenBeforeDeafen = await peak(streamAudio.rawAnalyser);
    b.ref.current.alternarAudio();
    await until(() => b.state.audioMudo, 'voice deafen enabled'); await wait(250);
    const screenAfterDeafen = await peak(streamAudio.rawAnalyser);
    check(voiceAudio.element.muted, 'Voice deafen must mute native voice playback');
    check(screenAfterDeafen > screenBeforeDeafen * 0.65, 'Voice deafen must preserve native screen playback level');
    result.snapshots.deafenedDuringPlayback = { voice: snapshot(voiceAudio), screen: snapshot(streamAudio) };

    const muteScreen = () => b.holder.querySelector('[aria-label="Mutar o áudio dessa tela"]');
    muteScreen().click();
    await until(() => streamAudio.element.muted, 'screen own mute applied'); await wait(200);
    check(streamAudio.element.muted, 'Own screen mute must mute native playback');
    b.ref.current.alternarAudio(); await until(() => !b.state.audioMudo, 'voice reenabled with screen own mute');
    check(streamAudio.element.muted, 'Voice toggle must preserve own screen mute');
    b.holder.querySelector('[aria-label="Ativar o áudio dessa tela"]').click();
    await until(() => !streamAudio.element.muted, 'screen own mute disabled');
    const slider = b.holder.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '35');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => Math.abs(streamAudio.element.volume - 0.35) < 0.001, 'screen own volume is applied');
    await b.ref.current.aplicarConfiguracao({ volumeSaida: 80 });
    await until(() => Math.abs(streamAudio.element.volume - 0.28) < 0.001 && Math.abs(voiceAudio.element.volume - 0.8) < 0.001, 'global and own stream volumes combine');
    await wait(250);
    result.snapshots.independentVolume = { voice: snapshot(voiceAudio), screen: snapshot(streamAudio) };
    check(await peak(streamAudio.rawAnalyser) > 0.005, 'Volume-controlled stream retains real received signal');
    check(video.srcObject === attached && redundantAssignments === 0, 'Audio controls must preserve video srcObject identity');
    result.video = { width: video.videoWidth, height: video.videoHeight, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, srcObjectAssignmentsDuringAudioChanges: redundantAssignments,
      requestedCaptureFps: screen.getVideoTracks()[0].getSettings().frameRate,
      senderMaxFps: peers.flatMap(peer => peer.getSenders().filter(sender => sender.track?.kind === 'video').map(sender => sender.getParameters().encodings[0]?.maxFramerate)) };
    b.ref.current.fecharTransmissao();
    await until(() => streamAudio.element.muted, 'closed screen playback muted');
    await wait(200); check(streamAudio.element.muted, 'Closing screen must mute its playback element');

    // Controller schedules actual oscillators on a real observed AudioContext.
    const contextCount = contexts.length;
    const ringtone = createDirectCallRingtone();
    ringtone.start('native-incoming', 'incoming');
    await until(() => contexts.length > contextCount, 'ringtone audio context exists');
    const ringtoneContext = contexts[contexts.length - 1];
    const incomingPeak = await peak(ringtoneContext.observedOutput, 1000);
    check(incomingPeak > 0.005, 'Incoming call must generate real WebAudio output');
    ringtone.stop(); await wait(100);
    const stoppedPeak = await peak(ringtoneContext.observedOutput, 300);
    check(stoppedPeak < 0.0001, 'Ringtone stop must clear active oscillators');
    ringtone.start('native-outgoing', 'outgoing');
    const outgoingPeak = await peak(ringtoneContext.observedOutput, 1000);
    check(outgoingPeak > 0.005, 'Outgoing call must generate real WebAudio output');
    ringtone.dispose(); await wait(100);
    check(ringtoneContext.state === 'closed', 'Ringtone dispose must close native AudioContext');
    result.ringtone = { incomingPeak, stoppedPeak, outgoingPeak, disposedContextState: ringtoneContext.state };
    check(errors.length === 0, `Unexpected native runtime errors: ${errors.join('\n')}`);
    result.errors = errors; result.passed = true;
    return result;
  } finally {
    roots.forEach(root => root.unmount()); clearInterval(drawing);
    generated.forEach(item => { item.oscillator.stop(); item.stream.getTracks().forEach(track => track.stop()); void item.context.close(); });
    await Promise.all(audioRecords.map(async record => { record.element.pause(); record.element.srcObject = null; await record.context.close(); }));
    await Promise.all(contexts.filter(context => context.state !== 'closed').map(context => context.close()));
    globalThis.AudioContext = NativeAudioContext; globalThis.Audio = NativeAudio; globalThis.RTCPeerConnection = NativePeer;
  }
}

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const entry = '/@astralis-native-voice-audio';
  vite = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), cacheDir: path.join(temporary, 'vite'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['react', 'react-dom/client'] },
    plugins: [{ name: 'astralis-native-voice-audio', resolveId(id) { if (id === entry) return '\0' + entry; },
      load(id) { if (id === '\0' + entry) return `window.runNativeVoiceAudio = ${browserRun.toString()}; window.nativeHarnessReady = true;`; },
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (request.url !== '/native-voice-audio') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><title>Astralis isolated voice/audio validation</title><body><script type="module" src="${entry}"></script></body>`);
      }); } }],
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const websocketOrigin = origin.replace('http:', 'ws:');
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith(`${websocketOrigin}/`) && !details.url.startsWith('devtools:') }));
  window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  const consoleErrors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  await window.loadURL(`${origin}/native-voice-audio`);
  await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const deadline = Date.now() + 15000; const poll = () => window.nativeHarnessReady ? resolve() : Date.now() > deadline ? reject(new Error("Harness failed to load")) : setTimeout(poll, 25); poll(); })');
  const result = await window.webContents.executeJavaScript('window.runNativeVoiceAudio()');
  result.versions = { electron: process.versions.electron, chrome: process.versions.chrome };
  result.consoleErrors = consoleErrors;
  assert.equal(result.passed, true); assert.deepEqual(result.errors, []); assert.deepEqual(consoleErrors, []);
  assert.equal(result.video.requestedCaptureFps, 60); assert.ok(result.video.senderMaxFps.every(fps => fps === 60));
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result, null, 2));
}).then(async () => { clearTimeout(watchdog); window?.destroy(); await vite?.close(); app.exit(0); }).catch(async error => {
  console.error(error); clearTimeout(watchdog); window?.destroy(); await vite?.close(); app.exit(1);
});
