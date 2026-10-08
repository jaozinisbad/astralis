import { getCaptureConstraints, resolveStreamQuality } from './streamQuality.mjs';
import { createStereoSampleQueue } from './audioSampleQueue.mjs';

const capturasAtivas = new WeakMap();
const capturasEncerradas = new WeakSet();
const avisosCaptura = new WeakMap();

function criarAudioFiltrado(electronAPI) {
  const AudioContextImpl = globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
  if (!AudioContextImpl || !electronAPI?.onAudioTelaChunk) return null;

  const context = new AudioContextImpl({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const queue = createStereoSampleQueue();
  const processor = context.createScriptProcessor(1024, 0, 2);
  processor.onaudioprocess = (event) => {
    queue.readInto(
      event.outputBuffer.getChannelData(0),
      event.outputBuffer.getChannelData(1),
    );
  };
  processor.connect(destination);

  const stopListening = electronAPI.onAudioTelaChunk((chunk) => {
    queue.pushPcm16Stereo(chunk);
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
  const qualidade = resolveStreamQuality(settings);
  const constraints = getCaptureConstraints(qualidade);
  const isElectronWindow = Boolean(electronAPI && qualidade.fonteId?.startsWith('window:'));
  const ignoringDiscord = Boolean(qualidade.fonteId?.startsWith('screen:') && qualidade.ignoreDiscordAudio && electronAPI?.iniciarCapturaExcluindoProcesso);
  if (qualidade.fonteId && electronAPI?.definirFonteCompartilhamento) {
    electronAPI.definirFonteCompartilhamento(qualidade.fonteId);
  }

  const stream = isElectronWindow
    ? await globalThis.navigator.mediaDevices.getUserMedia({
      audio: false,
      video: criarRestricoesVideoDeJanela(qualidade),
    })
    : await globalThis.navigator.mediaDevices.getDisplayMedia({
      video: constraints.video,
      audio: Boolean(constraints.audio && !ignoringDiscord),
    });

  if (isElectronWindow || qualidade.shareAudio === false) removerFaixasDeAudio(stream);

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = qualidade.contentType;

  let cleanupAudio = null;
  let processAudioStarted = false;
  let aviso = '';

  if (isElectronWindow && qualidade.shareAudio !== false) {
    const filteredAudio = criarAudioFiltrado(electronAPI);
    if (!filteredAudio?.track || !electronAPI?.iniciarCapturaAudioJanela) {
      filteredAudio?.cleanup();
      aviso = 'Não consegui preparar o áudio isolado dessa janela; compartilhando sem áudio.';
    } else {
      try {
        const result = await electronAPI.iniciarCapturaAudioJanela(qualidade.fonteId);
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
    const selectedMonitor = qualidade.fonteId?.startsWith('screen:');
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

  if (ignoringDiscord && qualidade.shareAudio !== false) {
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
