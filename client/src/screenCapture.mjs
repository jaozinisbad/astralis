import { getCaptureConstraints, resolveStreamQuality } from './streamQuality.mjs';
import { createStereoSampleQueue } from './audioSampleQueue.mjs';

const capturasAtivas = new WeakMap();
const capturasEncerradas = new WeakSet();
const avisosCaptura = new WeakMap();
const proprietariosAudioNativo = new WeakMap();

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
      // Equal minimum/maximum dimensions select Chromium's FIXED_RESOLUTION
      // policy, padding small or portrait windows into a 16:9 frame. Keep only
      // ceilings so capture can follow the source size and aspect ratio.
      maxWidth: largura,
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

export async function requestScreenCapture(settings = {}, electronAPI = globalThis.window?.electronAPI, { signal } = {}) {
  const erroCancelamento = () => new DOMException('A captura foi cancelada.', 'AbortError');
  if (signal?.aborted) throw erroCancelamento();
  const qualidade = resolveStreamQuality(settings);
  const constraints = getCaptureConstraints(qualidade);
  const isElectronWindow = Boolean(electronAPI && qualidade.fonteId?.startsWith('window:'));
  const ignoringDiscord = Boolean(qualidade.fonteId?.startsWith('screen:') && electronAPI?.iniciarCapturaExcluindoProcesso);
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

  // The operating-system permission prompt can complete after the user left
  // the room. Dispose its media before it can replace current native audio.
  if (signal?.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    throw erroCancelamento();
  }

  // Never retain unfiltered desktop audio, even if the browser returns an
  // unexpected track despite audio:false or an older caller passes false.
  removerFaixasDeAudio(stream);

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = qualidade.contentType;

  let cleanupAudio = null;
  let processAudioStarted = false;
  let proprietarioAudio = null;
  let aviso = '';

  function registrarPedidoAudio() {
    proprietarioAudio = {};
    proprietariosAudioNativo.set(electronAPI, proprietarioAudio);
  }

  async function pararAudioSeAtual() {
    if (!proprietarioAudio || proprietariosAudioNativo.get(electronAPI) !== proprietarioAudio) return;
    proprietariosAudioNativo.delete(electronAPI);
    try { await electronAPI.pararCapturaProcesso?.(); } catch {}
  }

  if (isElectronWindow && qualidade.shareAudio !== false) {
    const filteredAudio = criarAudioFiltrado(electronAPI);
    if (!filteredAudio?.track || !electronAPI?.iniciarCapturaAudioJanela) {
      filteredAudio?.cleanup();
      aviso = 'Não consegui preparar o áudio isolado dessa janela; compartilhando sem áudio.';
    } else {
      try {
        registrarPedidoAudio();
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
        if (processAudioStarted) await pararAudioSeAtual();
        processAudioStarted = false;
        aviso = 'Não consegui iniciar o áudio isolado dessa janela; compartilhando sem áudio.';
      }
    }
  } else if (!isElectronWindow && !ignoringDiscord && qualidade.shareAudio !== false) {
    aviso = 'O filtro de áudio do Discord não está disponível; compartilhando sem áudio.';
  }

  if (ignoringDiscord && qualidade.shareAudio !== false) {
    let filteredAudio = null;
    try {
      filteredAudio = criarAudioFiltrado(electronAPI);
      if (filteredAudio?.track) registrarPedidoAudio();
      const result = filteredAudio?.track
        ? await electronAPI.iniciarCapturaExcluindoProcesso('Discord.exe')
        : null;
      if (result?.sucesso && filteredAudio?.track) {
        processAudioStarted = true;
        stream.addTrack(filteredAudio.track);
        cleanupAudio = filteredAudio.cleanup;
      } else {
        filteredAudio?.cleanup();
        aviso = result?.mensagem || 'Não consegui excluir o áudio do Discord; compartilhando sem áudio.';
      }
    } catch {
      filteredAudio?.cleanup();
      if (processAudioStarted) {
        await pararAudioSeAtual();
        processAudioStarted = false;
      }
      aviso = 'Não consegui excluir o áudio do Discord; compartilhando sem áudio.';
      // Se o filtro por aplicativo não estiver disponível, continua sem áudio
      // para evitar incluir acidentalmente o som do Discord na transmissão.
    }
  }

  if (aviso) avisosCaptura.set(stream, aviso);
  capturasAtivas.set(stream, {
    cleanup: async () => {
      cleanupAudio?.();
      if (processAudioStarted) await pararAudioSeAtual();
    },
  });
  if (signal?.aborted) {
    await stopScreenCapture(stream, electronAPI);
    throw erroCancelamento();
  }
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
