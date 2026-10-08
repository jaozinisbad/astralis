import { getCaptureConstraints } from './streamQuality.mjs';

const capturasAtivas = new WeakMap();
const capturasEncerradas = new WeakSet();
const avisosCaptura = new WeakMap();

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

function criarRestricoesVideoDeJanela(settings) {
  const { video } = getCaptureConstraints(settings);
  const largura = video.width.ideal;
  const altura = video.height.ideal;
  const fps = video.frameRate.ideal;
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: settings.fonteId,
      minWidth: largura,
      maxWidth: largura,
      minHeight: altura,
      maxHeight: altura,
      minFrameRate: fps,
      maxFrameRate: fps,
    },
  };
}

function removerFaixasDeAudio(stream) {
  stream.getAudioTracks().forEach((track) => {
    stream.removeTrack?.(track);
    track.stop();
  });
}

export function getScreenCaptureWarning(stream) {
  return avisosCaptura.get(stream) || '';
}

export async function requestScreenCapture(settings = {}, electronAPI = globalThis.window?.electronAPI) {
  const constraints = getCaptureConstraints(settings);
  const isElectronWindow = Boolean(electronAPI && settings.fonteId?.startsWith('window:'));
  const ignoringDiscord = Boolean(settings.fonteId?.startsWith('screen:') && settings.ignoreDiscordAudio && electronAPI?.iniciarCapturaExcluindoProcesso);
  if (settings.fonteId && electronAPI?.definirFonteCompartilhamento) {
    electronAPI.definirFonteCompartilhamento(settings.fonteId);
  }

  const stream = isElectronWindow
    ? await globalThis.navigator.mediaDevices.getUserMedia({
      audio: false,
      video: criarRestricoesVideoDeJanela(settings),
    })
    : await globalThis.navigator.mediaDevices.getDisplayMedia({
      video: constraints.video,
      audio: Boolean(constraints.audio && !ignoringDiscord),
    });

  if (isElectronWindow || settings.shareAudio === false) removerFaixasDeAudio(stream);

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = settings.contentType === 'motion' ? 'motion' : 'detail';

  let cleanupAudio = null;
  let processAudioStarted = false;
  let aviso = '';

  if (isElectronWindow && settings.shareAudio !== false) {
    const filteredAudio = criarAudioFiltrado(electronAPI);
    if (!filteredAudio?.track || !electronAPI?.iniciarCapturaAudioJanela) {
      filteredAudio?.cleanup();
      aviso = 'Não consegui preparar o áudio isolado dessa janela; compartilhando sem áudio.';
    } else {
      try {
        const result = await electronAPI.iniciarCapturaAudioJanela(settings.fonteId);
        if (result?.sucesso) {
          processAudioStarted = true;
          stream.addTrack(filteredAudio.track);
          cleanupAudio = filteredAudio.cleanup;
        } else {
          filteredAudio.cleanup();
          aviso = (result?.mensagem || 'Não consegui capturar o áudio isolado dessa janela.') + ' Compartilhando sem áudio.';
        }
      } catch {
        filteredAudio.cleanup();
        aviso = 'Não consegui iniciar o áudio isolado dessa janela; compartilhando sem áudio.';
      }
    }
  } else if (!isElectronWindow && !ignoringDiscord) {
    const displaySurface = videoTrack?.getSettings?.().displaySurface;
    const selectedMonitor = settings.fonteId?.startsWith('screen:');
    const surfaceAllowsAudio = electronAPI
      ? selectedMonitor
      : displaySurface === 'monitor' || displaySurface === 'browser';
    if (!surfaceAllowsAudio) {
      if (stream.getAudioTracks().length) {
        removerFaixasDeAudio(stream);
        aviso = 'O áudio foi removido porque a fonte escolhida não permite identificar o áudio dessa janela.';
      }
    }
  }

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

  if (aviso) avisosCaptura.set(stream, aviso);
  capturasAtivas.set(stream, {
    cleanup: async () => {
      cleanupAudio?.();
      if (processAudioStarted) {
        try { await electronAPI.pararCapturaProcesso?.(); } catch {}
      }
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
