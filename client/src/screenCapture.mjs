import { getCaptureConstraints } from './streamQuality.mjs';

const capturasAtivas = new WeakMap();
const capturasEncerradas = new WeakSet();

function criarAudioFiltrado(electronAPI) {
  const AudioContextImpl = globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
  if (!AudioContextImpl || !electronAPI?.onAudioTelaChunk) return null;

  const context = new AudioContextImpl({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const left = [];
  const right = [];
  const maxSamples = 96_000;
  const processor = context.createScriptProcessor(4096, 0, 2);
  processor.onaudioprocess = (event) => {
    const outputLeft = event.outputBuffer.getChannelData(0);
    const outputRight = event.outputBuffer.getChannelData(1);
    for (let index = 0; index < outputLeft.length; index += 1) {
      outputLeft[index] = left.shift() || 0;
      outputRight[index] = right.shift() || 0;
    }
  };
  processor.connect(destination);

  const stopListening = electronAPI.onAudioTelaChunk((chunk) => {
    const bytes = new Uint8Array(chunk);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 3 < bytes.byteLength; offset += 4) {
      if (left.length >= maxSamples) break;
      left.push(view.getInt16(offset, true) / 32768);
      right.push(view.getInt16(offset + 2, true) / 32768);
    }
  });

  return {
    track: destination.stream.getAudioTracks()[0],
    cleanup() {
      stopListening?.();
      processor.disconnect();
      context.close().catch(() => {});
    },
  };
}

export async function requestScreenCapture(settings = {}, electronAPI = globalThis.window?.electronAPI) {
  const constraints = getCaptureConstraints(settings);
  const ignoringDiscord = Boolean(settings.ignoreDiscordAudio && electronAPI?.iniciarCapturaExcluindoProcesso);
  if (settings.fonteId && electronAPI?.definirFonteCompartilhamento) {
    electronAPI.definirFonteCompartilhamento(settings.fonteId);
  }

  const stream = await globalThis.navigator.mediaDevices.getDisplayMedia({
    video: constraints.video,
    audio: Boolean(constraints.audio && !ignoringDiscord),
  });
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = settings.contentType === 'motion' ? 'motion' : 'detail';

  let cleanupAudio = null;
  let processAudioStarted = false;
  if (ignoringDiscord && settings.shareAudio !== false) {
    try {
      const result = await electronAPI.iniciarCapturaExcluindoProcesso('Discord.exe');
      if (result?.sucesso) {
        processAudioStarted = true;
        const filteredAudio = criarAudioFiltrado(electronAPI);
        if (filteredAudio?.track) {
          stream.addTrack(filteredAudio.track);
          cleanupAudio = filteredAudio.cleanup;
        } else {
          await electronAPI.pararCapturaProcesso?.();
          processAudioStarted = false;
        }
      }
    } catch {
      // Se o filtro por aplicativo não estiver disponível, continua sem áudio
      // para evitar incluir acidentalmente o som do Discord na transmissão.
    }
  }

  capturasAtivas.set(stream, {
    cleanup: async () => {
      cleanupAudio?.();
      if (processAudioStarted) await electronAPI.pararCapturaProcesso?.();
    },
  });
  return stream;
}

export async function stopScreenCapture(stream, electronAPI = globalThis.window?.electronAPI) {
  if (!stream) return;
  if (capturasEncerradas.has(stream)) return;
  capturasEncerradas.add(stream);
  const capture = capturasAtivas.get(stream);
  capturasAtivas.delete(stream);
  await capture?.cleanup();
  stream.getTracks().forEach((track) => track.stop());
  if (!capture && electronAPI?.pararCapturaProcesso) {
    try {
      await electronAPI.pararCapturaProcesso();
    } catch {
      // O encerramento local da mídia não depende do IPC auxiliar.
    }
  }
}
