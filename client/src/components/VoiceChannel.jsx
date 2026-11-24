import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sincronizarReproducaoDasTelas } from '../audioTela.mjs';
import { getCaptureConstraints, getVideoEncodingParameters, resolveStreamQuality } from '../streamQuality.mjs';
import { resolveVideoCodecPreferences } from '../streamCodecs.mjs';
import { withScreenStartBitrate } from '../streamStartup.mjs';
import { DEFAULT_ROOM_ICE_SERVERS, loadVoiceIceConfiguration } from '../roomIceConfiguration.mjs';
import { createVoicePeerConnection } from '../voicePeerConnection.mjs';
import { alternarTelaCheia } from '../voiceFullscreen.mjs';
import { getScreenCaptureWarning, requestScreenCapture, stopScreenCapture } from '../screenCapture.mjs';
import VoiceCallStage from './VoiceCallStage.jsx';
import VoiceMiniPlayer from './VoiceMiniPlayer.jsx';


// O perfil de captura e o teto de bitrate vêm do seletor compartilhado
// com as salas; cada conexão P2P recebe o limite calculado para esse perfil.
// Bitrate de áudio mais alto que o padrão do Opus (que gira uns 32kbps)
// — com um microfone bom, vale a pena usar mais banda pra manter a
// clareza da voz.
const BITRATE_AUDIO = 128_000;
const OPCOES_ENTRADA = ['microfoneId', 'perfilEntrada', 'supressaoRuido', 'cancelamentoEco', 'ganhoAutomatico'];

// O áudio do sistema (jogo, música, etc.) se beneficia de mais banda
// ainda que a voz, já que costuma ter mais variação de frequência.
const BITRATE_AUDIO_TELA = 128_000;

// A mídia permanece conectada durante a navegação; visible controla o palco.
// O painel lateral usa os mesmos controles e o mesmo estado da chamada.
const VoiceChannel = forwardRef(function VoiceChannel(
  { canal, socket, nomeUsuario, usuario, visible = false, stageContainer, onCompartilharTela, onAbrirConfiguracoes,
    onDesconectar, onEstadoChange, onAbrirConversa, onAbrirChamada },
  ref
) {
  const [participantes, setParticipantes] = useState([]); // [{socketId, nome}]
  const [micMudo, setMicMudo] = useState(false);
  const [audioMudo, setAudioMudo] = useState(false);
  const [erro, setErro] = useState('');
  const [avisoMicrofone, setAvisoMicrofone] = useState('');
  const [erroCompartilhamento, setErroCompartilhamento] = useState('');
  const [telasMutadas, setTelasMutadas] = useState(() => new Set());
  const [volumesTelas, setVolumesTelas] = useState({});
  const [telaSelecionadaId, setTelaSelecionadaId] = useState(null);
  const [telaMinimizada, setTelaMinimizada] = useState(false);
  const [posicaoMiniPlayer, setPosicaoMiniPlayer] = useState(null);
  const [emTelaCheia, setEmTelaCheia] = useState(false);
  const [paginaInteira, setPaginaInteira] = useState(false);
  const [conectando, setConectando] = useState(true);
  const [connectionState, setConnectionState] = useState('connecting');
  const [compartilhamentoPendente, setCompartilhamentoPendente] = useState(false);
  const [compartilhandoTela, setCompartilhandoTela] = useState(false);
  const [telasRemotas, setTelasRemotas] = useState({}); // socketId -> MediaStream

  // Pipeline de áudio local: microfone -> ganho (volume ajustável) ->
  // stream final que de fato é enviada pros outros participantes. Antes
  // o "volume de entrada" das Configurações não tinha efeito nenhum no
  // que os outros ouviam (o nó de ganho só estava ligado à sua própria
  // saída de áudio, não à chamada) — agora ele fica no meio do caminho
  // de verdade.
  const streamLocalRef = useRef(null); // captura bruta do getUserMedia
  const streamEnviadaRef = useRef(null); // depois do GainNode — essa é a enviada
  const contextoEntradaRef = useRef(null);
  const ganhoEntradaRef = useRef(null);
  const origemEntradaRef = useRef(null);
  const filtroRuidoRef = useRef(null);
  const pedidoEntradaRef = useRef(0);
  const entradaAplicadaRef = useRef(null);

  const telaLocalRef = useRef(null);
  const pedidoCapturaTelaRef = useRef(0);
  const controladorCapturaTelaRef = useRef(null);

  function cancelarPedidoCapturaTela() {
    pedidoCapturaTelaRef.current += 1;
    controladorCapturaTelaRef.current?.abort();
    controladorCapturaTelaRef.current = null;
  }

  useEffect(() => () => cancelarPedidoCapturaTela(), []);
  const telaTileRef = useRef(null);
  const qualidadeTelaAtualRef = useRef(resolveStreamQuality());
  const preferenciasCodecPorFaixa = useRef(new WeakMap());
  const faixaComBitrateInicial = useRef(new WeakMap());
  const avisouFalhaQualidadeRef = useRef(false);
  const conexoesRef = useRef({}); // socketId -> RTCPeerConnection
  const negociacoesRef = useRef(new Map());
  const audiosRef = useRef({}); // socketId -> HTMLAudioElement (microfone)
  const audiosTelaRef = useRef({}); // socketId -> HTMLAudioElement (áudio do sistema de quem compartilha tela)
  const audioMudoRef = useRef(false);
  const telaSelecionadaRef = useRef(null);
  const telasMutadasRef = useRef(new Set());
  const volumesTelasRef = useRef({});
  const contextoAudioRef = useRef(null); // contexto só dos efeitos sonoros
  const telasComSomRef = useRef(new Set());
  const configuracaoAudioRef = useRef({ volumeEntrada: 100, volumeSaida: 100, microfoneId: '', foneId: '', perfilEntrada: 'isolamento', supressaoRuido: 'rnnoise', cancelamentoEco: true, ganhoAutomatico: true });
  // Aplica o teto escolhido e, se a pessoa ativou qualidade inteligente,
  // divide o orçamento entre espectadores para reduzir a demanda de upload.
  function aplicarQualidadeVideo(remetente) {
    const qualidade = qualidadeTelaAtualRef.current;
    const numEspectadores = Math.max(1, Object.keys(conexoesRef.current).length);
    const qualidadeVideo = getVideoEncodingParameters(qualidade, numEspectadores);
    const { video } = getCaptureConstraints(qualidade);
    const captura = remetente.track?.getSettings?.() || {};
    const escala = Math.max(1, (captura.width || 0) / video.width.max, (captura.height || 0) / video.height.max);
    const parametros = remetente.getParameters();
    const encodings = parametros.encodings?.length ? parametros.encodings : [{}];
    parametros.encodings = encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: qualidadeVideo.maxBitrate,
      maxFramerate: qualidade.fps,
      scaleResolutionDownBy: escala,
    }));
    parametros.degradationPreference = qualidadeVideo.degradationPreference;
    remetente.setParameters(parametros).catch(() => {
      if (avisouFalhaQualidadeRef.current) return;
      avisouFalhaQualidadeRef.current = true;
      setErroCompartilhamento('O navegador não conseguiu aplicar a qualidade de vídeo; a transmissão continuará com o ajuste disponível.');
    });
  }

  // Reaplica o bitrate em TODAS as conexões que já estão recebendo a tela —
  // precisa rodar sempre que alguém entra ou sai da call enquanto a tela tá
  // sendo compartilhada, senão quem já estava assistindo fica preso no
  // bitrate de antes (calculado pra um número diferente de espectadores).
  function reaplicarBitrateTela() {
    const videoTrack = telaLocalRef.current?.getVideoTracks()[0];
    if (!videoTrack) return;
    Object.values(conexoesRef.current).forEach((pc) => {
      const remetente = pc.getSenders().find((s) => s.track === videoTrack);
      if (!remetente) return;
      aplicarQualidadeVideo(remetente);
    });
  }

  // Avisa o App sempre que algo que a sidebar precisa mostrar mudar.
  useEffect(() => {
    const streams = { ...telasRemotas };
    if (compartilhandoTela && socket?.id && telaLocalRef.current) streams[socket.id] = telaLocalRef.current;
    onEstadoChange?.({
      participantes,
      micMudo,
      audioMudo,
      compartilhandoTela,
      telasAtivas: Object.keys(streams),
      streams,
      telaSelecionadaId,
      erro,
      avisoMicrofone,
      erroCompartilhamento,
      conectando,
      connectionState,
      compartilhamentoPendente,
    });
  }, [participantes, micMudo, audioMudo, compartilhandoTela, telasRemotas, telaSelecionadaId, socket, erro, avisoMicrofone, erroCompartilhamento, conectando, connectionState, compartilhamentoPendente]);

  // Inicializa a configuração de áudio do localStorage
  useEffect(() => {
    const salva = localStorage.getItem('configuracoesAudio');
    if (salva) {
      try {
        configuracaoAudioRef.current = { ...configuracaoAudioRef.current, ...JSON.parse(salva) };
      } catch {
        configuracaoAudioRef.current = { volumeEntrada: 100, volumeSaida: 100, microfoneId: '', foneId: '', perfilEntrada: 'isolamento', supressaoRuido: 'rnnoise', cancelamentoEco: true, ganhoAutomatico: true };
      }
    }
  }, []);

  function tocarEfeito(tipo) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const contexto = contextoAudioRef.current || new AudioContext();
      contextoAudioRef.current = contexto;
      contexto.resume().catch(() => {});

      const frequencias = {
        entrar: [523.25, 659.25],
        sair: [659.25, 523.25],
        transmitir: [659.25, 783.99],
        transmissaoRecebida: [783.99, 987.77],
      }[tipo];
      if (!frequencias) return;

      const agora = contexto.currentTime;
      frequencias.forEach((frequencia, indice) => {
        const oscilador = contexto.createOscillator();
        const ganho = contexto.createGain();
        oscilador.type = 'sine';
        oscilador.frequency.value = frequencia;
        ganho.gain.setValueAtTime(0.0001, agora + indice * 0.1);
        ganho.gain.exponentialRampToValueAtTime(0.08, agora + indice * 0.1 + 0.02);
        ganho.gain.exponentialRampToValueAtTime(0.0001, agora + indice * 0.1 + 0.18);
        oscilador.connect(ganho);
        ganho.connect(contexto.destination);
        oscilador.start(agora + indice * 0.1);
        oscilador.stop(agora + indice * 0.1 + 0.2);
      });
    } catch (err) {
      // Efeitos sonoros não podem interromper a chamada.
    }
  }

  async function criarFiltroRuido(contexto) {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const processador = contexto.createScriptProcessor(1024, 1, 1);
    const estado = rnnoise.createDenoiseState();
    const entrada = [];
    const saida = [];
    processador.onaudioprocess = (evento) => {
      const canalEntrada = evento.inputBuffer.getChannelData(0);
      const canalSaida = evento.outputBuffer.getChannelData(0);
      for (let i = 0; i < canalEntrada.length; i += 1) entrada.push(canalEntrada[i]);
      while (entrada.length >= rnnoise.frameSize) {
        const quadro = Float32Array.from(entrada.splice(0, rnnoise.frameSize));
        estado.processFrame(quadro);
        for (let i = 0; i < quadro.length; i += 1) saida.push(quadro[i]);
      }
      for (let i = 0; i < canalSaida.length; i += 1) canalSaida[i] = saida.length ? saida.shift() : 0;
    };
    return { no: processador, destruir() { processador.disconnect(); estado.destroy(); } };
  }

  async function montarPipelineDeEntrada(config, pedido) {
    const deviceId = config.microfoneId;
    const isolamento = config.perfilEntrada !== 'estudio';
    const usarRnnoise = isolamento && config.supressaoRuido === 'rnnoise';
    const constraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: isolamento && config.cancelamentoEco !== false,
        noiseSuppression: isolamento && config.supressaoRuido !== 'desligada',
        autoGainControl: isolamento && config.ganhoAutomatico !== false,
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 1 },
      },
    };
    let streamBruta;
    try {
      streamBruta = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name !== 'OverconstrainedError' || !deviceId || streamLocalRef.current || pedido !== pedidoEntradaRef.current) throw err;

      // O dispositivo salvo pode ter sido removido ou renomeado no Windows.
      // Nesse caso, deixa o sistema escolher o microfone padrão.
      streamBruta = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: isolamento && config.cancelamentoEco !== false,
          noiseSuppression: isolamento && config.supressaoRuido !== 'desligada',
          autoGainControl: isolamento && config.ganhoAutomatico !== false,
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 1 },
        },
      });
    }

    const contextoAtivo = contextoEntradaRef.current;
    let contexto = contextoAtivo;
    let origem, filtro, destino;
    let aplicada = false;
    try {
      if (pedido !== pedidoEntradaRef.current) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      contexto ??= new AudioContext();
      origem = contexto.createMediaStreamSource(streamBruta);
      if (usarRnnoise) filtro = await criarFiltroRuido(contexto).catch(() => null);
      if (pedido !== pedidoEntradaRef.current) return;

      // Os participantes continuam recebendo a mesma faixa de saída durante a troca.
      const ganho = ganhoEntradaRef.current || contexto.createGain();
      if (!contextoAtivo) {
        ganho.gain.value = (configuracaoAudioRef.current.volumeEntrada ?? 100) / 100;
        destino = contexto.createMediaStreamDestination();
        ganho.connect(destino);
      }
      const habilitada = streamLocalRef.current?.getAudioTracks()[0]?.enabled ?? !micMudo;
      streamBruta.getAudioTracks().forEach(track => { track.enabled = habilitada; });
      if (filtro) filtro.no.connect(ganho);
      origem.connect(filtro?.no || ganho);

      origemEntradaRef.current?.disconnect?.();
      filtroRuidoRef.current?.destruir();
      streamLocalRef.current?.getTracks().forEach(track => track.stop());
      streamLocalRef.current = streamBruta;
      origemEntradaRef.current = origem;
      filtroRuidoRef.current = filtro;
      contextoEntradaRef.current = contexto;
      ganhoEntradaRef.current = ganho;
      if (destino) streamEnviadaRef.current = destino.stream;
      entradaAplicadaRef.current = config;
      aplicada = true;
    } finally {
      if (!aplicada) {
        streamBruta.getTracks().forEach(track => track.stop());
        origem?.disconnect?.();
        filtro?.destruir();
        destino?.stream.getTracks().forEach(track => track.stop());
        if (!contextoAtivo) contexto?.close().catch(() => {});
      }
    }
  }

  function liberarEntrada() {
    pedidoEntradaRef.current += 1;
    streamLocalRef.current?.getTracks().forEach(track => track.stop());
    streamEnviadaRef.current?.getTracks().forEach(track => track.stop());
    origemEntradaRef.current?.disconnect?.();
    filtroRuidoRef.current?.destruir();
    contextoEntradaRef.current?.close().catch(() => {});
    streamLocalRef.current = streamEnviadaRef.current = null;
    origemEntradaRef.current = filtroRuidoRef.current = null;
    ganhoEntradaRef.current = contextoEntradaRef.current = null;
    entradaAplicadaRef.current = null;
  }

  function aplicarVolumeESaidaNosAudios() {
    const volume = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100;
    const foneId = configuracaoAudioRef.current.foneId;
    Object.values(audiosRef.current).forEach((audio) => {
      audio.volume = volume;
      if (foneId && audio.setSinkId) {
        audio.setSinkId(foneId).catch(() => {});
      }
    });
    Object.entries(audiosTelaRef.current).forEach(([socketId, audio]) => {
      audio.volume = volume * (volumesTelasRef.current[socketId] ?? 100) / 100;
      if (foneId && audio.setSinkId) {
        audio.setSinkId(foneId).catch(() => {});
      }
    });
  }

  // Aplica um bitrate mais alto no áudio enviado pra essa conexão.
  function configurarQualidadeDeAudio(pc) {
    const remetente = pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!remetente) return;
    const parametros = remetente.getParameters();
    parametros.encodings = (parametros.encodings && parametros.encodings.length ? parametros.encodings : [{}]).map(
      (encoding) => ({ ...encoding, maxBitrate: BITRATE_AUDIO }),
    );
    remetente.setParameters(parametros).catch(() => {});
  }

  async function configurarCodecTela(pc) {
    const track = telaLocalRef.current?.getVideoTracks()[0];
    const transceiver = track && pc.getTransceivers?.().find((item) => item.sender.track === track);
    if (typeof transceiver?.setCodecPreferences === 'function') {
      const cache = preferenciasCodecPorFaixa.current;
      if (!cache.has(track)) {
        cache.set(track, resolveVideoCodecPreferences({ quality: qualidadeTelaAtualRef.current, track }).catch(() => []));
      }
      const preferencias = await cache.get(track);
      if (transceiver.sender.track !== track) return;
      if (preferencias.length) {
        try { transceiver.setCodecPreferences(preferencias); } catch {}
      }
    }
  }

  useEffect(() => {
    if (!socket) return;
    let cancelado = false;
    let entrou = false;
    let peerQueReconecta = null;
    let retomandoChamadaDireta = false;
    const statusDosPeers = new Map();
    const candidatosIniciais = new Map();

    function atualizarConexao() {
      if (!entrou || cancelado) return;
      const estados = [...statusDosPeers.values()];
      if (estados.includes('connected')) retomandoChamadaDireta = false;
      if (estados.includes('reconnecting')) setConnectionState('reconnecting');
      else if (estados.includes('failed')) setConnectionState('failed');
      else if (retomandoChamadaDireta) setConnectionState('reconnecting');
      else if (estados.includes('connecting')) setConnectionState('connecting');
      else setConnectionState('connected');
    }

    function criarConexao(socketId) {
      const pc = new RTCPeerConnection({ iceServers: DEFAULT_ROOM_ICE_SERVERS });
      conexoesRef.current[socketId] = pc;
      statusDosPeers.set(socketId, 'connecting');
      atualizarConexao();

      streamEnviadaRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, streamEnviadaRef.current);
      });
      configurarQualidadeDeAudio(pc);

      telaLocalRef.current?.getTracks().forEach((track) => {
        const remetente = pc.addTrack(track, telaLocalRef.current);
        if (track.kind === 'video') {
          aplicarQualidadeVideo(remetente);
        } else if (track.kind === 'audio') {
          const parametros = remetente.getParameters();
          parametros.encodings = (parametros.encodings?.length ? parametros.encodings : [{}]).map(
            (encoding) => ({ ...encoding, maxBitrate: BITRATE_AUDIO_TELA }),
          );
          remetente.setParameters(parametros).catch(() => {});
        }
      });
      // Chegou mais um espectador: reequilibra o bitrate de quem já estava
      // vendo, já que agora a banda de upload precisa ser dividida entre
      // mais gente.
      if (telaLocalRef.current) queueMicrotask(() => reaplicarBitrateTela());

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('webrtc-candidato', { para: socketId, candidato: e.candidate });
        }
      };

      let servidoresIce = DEFAULT_ROOM_ICE_SERVERS;
      let iceConfigurado = false;
      const negociacao = createVoicePeerConnection({
        peer: pc,
        polite: socket.id > socketId,
        prepare: async ({ offer, restart }) => {
          if (!iceConfigurado || restart) {
            const servidores = await loadVoiceIceConfiguration(socket);
            if (conexoesRef.current[socketId] !== pc) return;
            if (servidores !== servidoresIce && typeof pc.setConfiguration === 'function') {
              try {
                pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servidores });
                servidoresIce = servidores;
              } catch {}
            }
            iceConfigurado = true;
          }
          if (offer) await configurarCodecTela(pc);
        },
        emit: (evento, campo, descricao) => socket.emit(evento, { para: socketId, [campo]: descricao }),
        onStatus: (estado) => {
          statusDosPeers.set(socketId, estado);
          atualizarConexao();
        },
      });
      negociacoesRef.current.set(socketId, negociacao);
      for (const candidato of candidatosIniciais.get(socketId) || []) void negociacao.receiveCandidate(candidato);
      candidatosIniciais.delete(socketId);

      let videoRemotoAtual;
      pc.ontrack = (e) => {
        if (e.track.kind === 'audio') {
          // Se essa faixa de áudio veio junto de um vídeo no mesmo
          // stream, é o áudio do sistema de quem está compartilhando a
          // tela — precisa de um elemento <audio> separado do
          // microfone, senão um substitui o outro.
          const streamRemoto = e.streams[0];
          // O áudio da tela pode chegar antes do vídeo na renegociação.
          const ehAudioDeTela = streamRemoto?.getVideoTracks().length > 0
            || (audiosRef.current[socketId]?.srcObject
              && audiosRef.current[socketId].srcObject !== streamRemoto);
          const bucket = ehAudioDeTela ? audiosTelaRef : audiosRef;

          let audio = bucket.current[socketId];
          if (!audio) {
            audio = new Audio();
            audio.autoplay = true;
            audio.muted = ehAudioDeTela
              ? telasMutadasRef.current.has(socketId) || telaSelecionadaRef.current !== socketId
              : audioMudoRef.current;
            const volumeSaida = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100;
            audio.volume = ehAudioDeTela
              ? volumeSaida * (volumesTelasRef.current[socketId] ?? 100) / 100
              : volumeSaida;
            if (configuracaoAudioRef.current.foneId && audio.setSinkId) {
              audio.setSinkId(configuracaoAudioRef.current.foneId).catch(() => {});
            }
            bucket.current[socketId] = audio;
          }
          audio.srcObject = streamRemoto;
          if (ehAudioDeTela) {
            audio.volume = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100
              * (volumesTelasRef.current[socketId] ?? 100) / 100;
            sincronizarAudioDasTelas();
          } else {
            audio.muted = audioMudoRef.current;
            audio.volume = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100;
          }
        } else if (e.track.kind === 'video') {
          // Reclassifica o áudio caso a faixa de vídeo chegue depois dele.
          const audioInicial = audiosRef.current[socketId];
          if (audioInicial?.srcObject === e.streams[0]) {
            const audioClassificadoComoTela = audiosTelaRef.current[socketId];
            if (audioClassificadoComoTela?.srcObject && audioClassificadoComoTela.srcObject !== e.streams[0]) {
              audiosRef.current[socketId] = audioClassificadoComoTela;
              audioClassificadoComoTela.muted = audioMudoRef.current;
              audioClassificadoComoTela.volume = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100;
            } else {
              if (audioClassificadoComoTela) {
                audioClassificadoComoTela.pause();
                audioClassificadoComoTela.srcObject = null;
              }
              delete audiosRef.current[socketId];
            }
            audiosTelaRef.current[socketId] = audioInicial;
            audioInicial.volume = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100
              * (volumesTelasRef.current[socketId] ?? 100) / 100;
            sincronizarAudioDasTelas();
          }
          if (!telasComSomRef.current.has(socketId)) {
            telasComSomRef.current.add(socketId);
            tocarEfeito('transmissaoRecebida');
          }
          const streamRecebida = e.streams[0];
          videoRemotoAtual = e.track;
          setTelasRemotas((atual) => ({ ...atual, [socketId]: streamRecebida }));
          e.track.onended = () => {
            setTelasRemotas((atual) => {
              if (videoRemotoAtual !== e.track || atual[socketId] !== streamRecebida) return atual;
              const copia = { ...atual };
              delete copia[socketId];
              return copia;
            });
          };
        }
      };

      return pc;
    }

    function fecharConexao(socketId) {
      negociacoesRef.current.get(socketId)?.close();
      negociacoesRef.current.delete(socketId);
      candidatosIniciais.delete(socketId);
      statusDosPeers.delete(socketId);
      conexoesRef.current[socketId]?.close();
      delete conexoesRef.current[socketId];
      atualizarConexao();
      if (audiosRef.current[socketId]) {
        audiosRef.current[socketId].srcObject = null;
        delete audiosRef.current[socketId];
      }
      if (audiosTelaRef.current[socketId]) {
        audiosTelaRef.current[socketId].srcObject = null;
        delete audiosTelaRef.current[socketId];
      }
      setTelasRemotas((atual) => {
        const copia = { ...atual };
        delete copia[socketId];
        return copia;
      });
      // Alguém saiu: sobra mais banda de upload pra dividir entre quem
      // ficou vendo a tela, então reequilibra pra cima.
      if (telaLocalRef.current) reaplicarBitrateTela();
    }

    function removerTelaRemota(socketId) {
      telasComSomRef.current.delete(socketId);
      if (audiosTelaRef.current[socketId]) {
        audiosTelaRef.current[socketId].srcObject = null;
        delete audiosTelaRef.current[socketId];
      }
      setTelasRemotas((atual) => {
        const copia = { ...atual };
        const stream = copia[socketId];
        stream?.getVideoTracks().forEach((track) => track.stop());
        delete copia[socketId];
        return copia;
      });
    }

    async function iniciar() {
      setConectando(true);
      setConnectionState('connecting');
      setErro('');
      try {
        setAvisoMicrofone('');
        const pedido = ++pedidoEntradaRef.current;
        await montarPipelineDeEntrada(configuracaoAudioRef.current, pedido);
        if (cancelado || pedido !== pedidoEntradaRef.current) return;
        socket.emit('entrar-canal-voz', canal.id);
      } catch (err) {
        if (cancelado) return;
        const mensagem = err.name === 'NotFoundError'
          ? 'Nenhum microfone foi encontrado neste computador.'
          : err.name === 'NotAllowedError' || err.name === 'SecurityError'
            ? 'O acesso ao microfone foi bloqueado. Verifique as permissões do Windows.'
            : err.name === 'OverconstrainedError'
              ? 'O microfone selecionado não está disponível. Escolha outro nas configurações de áudio.'
              : 'Não foi possível acessar o microfone. Verifique as configurações de áudio.';
        setErro(mensagem);
        setConectando(false);
        setConnectionState('failed');
      }
    }

    socket.on('peers-existentes', ({ peers }) => {
      entrou = true;
      setConectando(false);
      setParticipantes([
        ...peers,
        { socketId: socket.id, nome: nomeUsuario },
      ]);
      peers.forEach((p) => {
        if (conexoesRef.current[p.socketId]) return;
        criarConexao(p.socketId);
        void negociacoesRef.current.get(p.socketId)?.offer();
      });
      atualizarConexao();
    });

    socket.on('novo-peer', ({ socketId, nome, avatarCor, avatarUrl }) => {
      if (peerQueReconecta) {
        statusDosPeers.delete(peerQueReconecta);
        peerQueReconecta = null;
        statusDosPeers.set(socketId, 'connecting');
        atualizarConexao();
      }
      if (!retomandoChamadaDireta) tocarEfeito('entrar');
      setParticipantes((atual) => [...atual.filter((item) => item.socketId !== socketId), { socketId, nome, avatarCor: avatarCor || '#9270f4', avatarUrl: avatarUrl || null }]);
    });

    socket.on('webrtc-oferta', ({ de, oferta }) => {
      if (cancelado || !entrou) return;
      const conexaoNova = !conexoesRef.current[de];
      if (conexaoNova) criarConexao(de);
      // A resposta só inclui as mídias pedidas pela oferta.
      return negociacoesRef.current.get(de)?.receiveOffer(oferta, conexaoNova && Boolean(telaLocalRef.current));
    });

    socket.on('webrtc-resposta', ({ de, resposta }) => {
      const pc = conexoesRef.current[de];
      if (!pc) return;
      return negociacoesRef.current.get(de)?.receiveAnswer(resposta, (descricao) => {
        const track = telaLocalRef.current?.getVideoTracks()[0];
        const transceiver = track && pc.getTransceivers?.().find((item) => item.sender.track === track);
        if (!transceiver || faixaComBitrateInicial.current.get(pc) === track) return descricao;
        const maxBitrate = getVideoEncodingParameters(qualidadeTelaAtualRef.current, Object.keys(conexoesRef.current).length).maxBitrate;
        const ajustada = withScreenStartBitrate(descricao, transceiver.mid, maxBitrate);
        if (ajustada !== descricao) faixaComBitrateInicial.current.set(pc, track);
        return ajustada;
      });
    });

    socket.on('webrtc-candidato', ({ de, candidato }) => {
      if (cancelado || !entrou || !candidato) return;
      const negociacao = negociacoesRef.current.get(de);
      if (negociacao) return negociacao.receiveCandidate(candidato);
      if (!candidatosIniciais.has(de) && candidatosIniciais.size >= 32) return;
      const fila = candidatosIniciais.get(de) || [];
      if (fila.length < 128) fila.push(candidato);
      candidatosIniciais.set(de, fila);
    });

    socket.on('peer-saiu', ({ socketId, reconnecting }) => {
      if (reconnecting && canal.direta) retomandoChamadaDireta = true;
      else tocarEfeito('sair');
      telasComSomRef.current.delete(socketId);
      fecharConexao(socketId);
      if (reconnecting && canal.direta) {
        peerQueReconecta = socketId;
        statusDosPeers.set(socketId, 'reconnecting');
        atualizarConexao();
      }
      setParticipantes((atual) => atual.filter((p) => p.socketId !== socketId));
    });

    socket.on('tela-parada', ({ socketId }) => {
      removerTelaRemota(socketId);
    });

    function desconectado() {
      entrou = false;
      retomandoChamadaDireta = Boolean(canal.direta && socket.active);
      setConectando(false);
      setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
    }
    function entradaRecusada({ error } = {}) {
      if (cancelado) return;
      setConectando(false);
      setConnectionState('failed');
      setErro(error || 'Não foi possível entrar na chamada.');
      liberarEntrada();
    }
    function reconectado() {
      if (!streamEnviadaRef.current || cancelado) return;
      entrou = false;
      Object.keys(conexoesRef.current).forEach(fecharConexao);
      statusDosPeers.clear();
      peerQueReconecta = null;
      candidatosIniciais.clear();
      setParticipantes([]);
      setConectando(true);
      setConnectionState(retomandoChamadaDireta ? 'reconnecting' : 'connecting');
      if (!canal.direta) socket.emit('entrar-canal-voz', canal.id);
    }
    socket.on('disconnect', desconectado);
    socket.on('voz:erro', entradaRecusada);
    socket.on('connect', reconectado);

    iniciar();

    return () => {
      cancelado = true;
      cancelarPedidoCapturaTela();
      socket.emit('sair-canal-voz');
      socket.off('peers-existentes');
      socket.off('novo-peer');
      socket.off('webrtc-oferta');
      socket.off('webrtc-resposta');
      socket.off('webrtc-candidato');
      socket.off('peer-saiu');
      socket.off('tela-parada');
      socket.off('disconnect', desconectado);
      socket.off('voz:erro', entradaRecusada);
      socket.off('connect', reconectado);

      Object.keys(conexoesRef.current).forEach(fecharConexao);
      liberarEntrada();
      stopScreenCapture(telaLocalRef.current).catch(() => {});
      telaLocalRef.current = null;
      setParticipantes([]);
      setTelasRemotas({});
      setTelaSelecionadaId(null);
      telasComSomRef.current.clear();
      setCompartilhandoTela(false);
      setAudioMudo(false);
      contextoAudioRef.current?.close().catch(() => {});
      contextoAudioRef.current = null;
    };
  }, [canal.id, socket]);

  function alternarMudo() {
    const stream = streamLocalRef.current;
    if (!stream) return;
    const novoEstado = !micMudo;
    stream.getAudioTracks().forEach((t) => (t.enabled = !novoEstado));
    setMicMudo(novoEstado);
  }

  function alternarAudio() {
    const novoEstado = !audioMudo;
    audioMudoRef.current = novoEstado;
    Object.values(audiosRef.current).forEach((audio) => {
      audio.muted = novoEstado;
    });
    setAudioMudo(novoEstado);
  }

  async function renegociarComTodos() {
    await Promise.all([...negociacoesRef.current.values()].map((negociacao) => negociacao.offer()));
  }

  // CORREÇÃO DO BUG "sempre compartilha o monitor 1": antes de chamar
  // getDisplayMedia(), avisamos o processo principal do Electron qual
  // fonte foi escolhida no seletor — sem isso, o Electron sempre decidia
  // sozinho (e sempre escolhia a primeira tela da lista).
  async function iniciarCompartilhamento(config) {
    controladorCapturaTelaRef.current?.abort();
    const controller = new AbortController();
    controladorCapturaTelaRef.current = controller;
    const pedido = ++pedidoCapturaTelaRef.current;
    setCompartilhamentoPendente(true);
    try {
      setErroCompartilhamento('');
      avisouFalhaQualidadeRef.current = false;
      const qualidade = resolveStreamQuality(config);

      // Both rooms and voice channels share the same capture and audio policy.
      const stream = config?.stream || await requestScreenCapture(qualidade, undefined, { signal: controller.signal });
      if (pedido !== pedidoCapturaTelaRef.current) {
        await stopScreenCapture(stream);
        return;
      }
      const aviso = getScreenCaptureWarning(stream);
      if (aviso) setErroCompartilhamento(aviso);
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrackTela = stream.getAudioTracks()[0];
      if (!videoTrack) {
        await stopScreenCapture(stream);
        throw new Error('A captura não retornou vídeo.');
      }
      videoTrack.onended = () => {
        if (telaLocalRef.current === stream) pararCompartilhamento();
      };

      const streamAnterior = telaLocalRef.current;
      if (streamAnterior && streamAnterior !== stream) {
        const tracksAnteriores = streamAnterior.getTracks();
        Object.values(conexoesRef.current).forEach((pc) => {
          pc.getSenders().filter((sender) => tracksAnteriores.includes(sender.track)).forEach((sender) => pc.removeTrack(sender));
        });
      }
      telaLocalRef.current = stream;
      if (streamAnterior && streamAnterior !== stream) stopScreenCapture(streamAnterior).catch(() => {});
      qualidadeTelaAtualRef.current = qualidade;
      setCompartilhandoTela(true);
      if (visible && socket?.id) {
        setTelaMinimizada(false);
        setTelaSelecionadaId(socket.id);
      }
      tocarEfeito('transmitir');

      Object.values(conexoesRef.current).forEach((pc) => {
        const remetente = pc.addTrack(videoTrack, stream);
        aplicarQualidadeVideo(remetente);

        // Áudio do sistema (jogo, música, etc.) — vai como uma segunda
        // faixa de áudio, separada da sua voz no microfone.
        if (audioTrackTela) {
          const remetenteAudio = pc.addTrack(audioTrackTela, stream);
          const parametrosAudio = remetenteAudio.getParameters();
          parametrosAudio.encodings = (parametrosAudio.encodings?.length ? parametrosAudio.encodings : [{}]).map(
            (encoding) => ({ ...encoding, maxBitrate: BITRATE_AUDIO_TELA }),
          );
          remetenteAudio.setParameters(parametrosAudio).catch(() => {});
        }
      });
      await renegociarComTodos();
    } catch (err) {
      if (pedido !== pedidoCapturaTelaRef.current) return;
      setErroCompartilhamento(
        err?.name === 'AbortError'
          ? 'Compartilhamento de tela cancelado.'
          : 'Não foi possível compartilhar a tela. Verifique as permissões do sistema.',
      );
    } finally {
      if (pedido === pedidoCapturaTelaRef.current) setCompartilhamentoPendente(false);
    }
  }

  async function pararCompartilhamento() {
    cancelarPedidoCapturaTela();
    setCompartilhamentoPendente(false);
    const stream = telaLocalRef.current;
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrackSistema = stream.getAudioTracks()[0];

    Object.values(conexoesRef.current).forEach((pc) => {
      pc.getSenders().forEach((remetente) => {
        if (
          remetente.track === videoTrack ||
          (audioTrackSistema && remetente.track === audioTrackSistema)
        ) {
          pc.removeTrack(remetente);
        }
      });
    });

    socket.emit('tela-parada');
    telaLocalRef.current = null;
    await stopScreenCapture(stream);

    setCompartilhandoTela(false);
    await renegociarComTodos();
  }

  async function abrirTelaCheia() {
    try {
      const elemento = telaTileRef.current;
      if (!elemento) {
        throw new Error('Painel da transmissão não encontrado.');
      }
      setPaginaInteira(await alternarTelaCheia(elemento, document, paginaInteira));
      setErroCompartilhamento('');
    } catch (err) {
      console.error('Falha ao abrir tela cheia:', err);
      setErroCompartilhamento('Não foi possível abrir a transmissão em tela cheia.');
    }
  }

  // CORREÇÃO: antes, o volume de entrada era aplicado num GainNode que só
  // estava ligado à SUA PRÓPRIA saída de áudio — não tinha efeito nenhum
  // no que os outros ouviam. Agora ele ajusta o ganho real do pipeline
  // que alimenta a chamada. A troca de microfone também agora troca de
  // verdade (antes dependia de um IPC sem handler no processo principal,
  // que sempre falhava em silêncio).
  async function aplicarConfiguracao(config) {
    if (!config) return;

    const configuracaoAnterior = configuracaoAudioRef.current;
    const precisaReconstruirEntrada = OPCOES_ENTRADA
      .some((chave) => config[chave] !== undefined && config[chave] !== configuracaoAnterior[chave]);
    configuracaoAudioRef.current = { ...configuracaoAudioRef.current, ...config };

    if (config.volumeEntrada !== undefined && ganhoEntradaRef.current && contextoEntradaRef.current) {
      const volume = Math.max(0, Math.min(200, config.volumeEntrada)) / 100;
      ganhoEntradaRef.current.gain.setValueAtTime(volume, contextoEntradaRef.current.currentTime);
    }

    if (config.volumeSaida !== undefined || config.foneId !== undefined) {
      aplicarVolumeESaidaNosAudios();
    }

    if (precisaReconstruirEntrada && streamLocalRef.current) {
      const pedido = ++pedidoEntradaRef.current;
      const desejada = configuracaoAudioRef.current;
      const aplicada = entradaAplicadaRef.current;
      setAvisoMicrofone('');
      if (OPCOES_ENTRADA.every(chave => desejada[chave] === aplicada[chave])) return;
      try {
        await montarPipelineDeEntrada(desejada, pedido);
      } catch {
        if (pedido !== pedidoEntradaRef.current) return;
        for (const chave of OPCOES_ENTRADA) configuracaoAudioRef.current[chave] = aplicada[chave];
        setAvisoMicrofone('Não foi possível trocar de microfone. O microfone anterior continua selecionado.');
      }
    }
  }

  // Funções chamáveis de fora (pela barra de controle na sidebar).
  useImperativeHandle(ref, () => ({
    alternarMudo,
    alternarAudio,
    iniciarCompartilhamento,
    pararCompartilhamento,
    aplicarConfiguracao,
    alternarTransmissao,
    abrirTransmissao,
    fecharTransmissao: () => setTelaSelecionadaId(null),
  }));

  function alternarTransmissao(socketId) {
    if (telaMinimizada) {
      abrirTransmissao(socketId);
      return;
    }
    setTelaSelecionadaId((atual) => atual === socketId ? null : socketId);
  }

  function abrirTransmissao(socketId) {
    setTelaMinimizada(false);
    setTelaSelecionadaId(socketId);
  }

  function sincronizarAudioDasTelas() {
    sincronizarReproducaoDasTelas(audiosTelaRef.current, {
      telasMutadas: telasMutadasRef.current,
      telaSelecionadaId: telaSelecionadaRef.current,
    });
  }

  // Muda só o áudio, sem parar de ver a tela. Fechar a transmissão também
  // para sua reprodução de áudio. Cada tela compartilhada tem seu áudio
  // próprio — isso não mexe no seu microfone nem no áudio de mais
  // ninguém na call.
  function alternarMuteTela(socketId) {
    const copia = new Set(telasMutadasRef.current);
    if (copia.has(socketId)) copia.delete(socketId);
    else copia.add(socketId);
    telasMutadasRef.current = copia;
    setTelasMutadas(copia);
    sincronizarAudioDasTelas();
  }

  function alterarVolumeTela(socketId, volume) {
    const volumeLimitado = Math.max(0, Math.min(100, Number(volume)));
    const volumes = { ...volumesTelasRef.current, [socketId]: volumeLimitado };
    volumesTelasRef.current = volumes;
    setVolumesTelas(volumes);
    const audio = audiosTelaRef.current[socketId];
    if (audio) {
      const volumeSaida = (configuracaoAudioRef.current.volumeSaida ?? 100) / 100;
      audio.volume = volumeSaida * volumeLimitado / 100;
    }
  }

  const telaLocalSelecionada = compartilhandoTela && telaSelecionadaId === socket?.id;
  const streamSelecionada = telaLocalSelecionada
    ? telaLocalRef.current
    : telasRemotas[telaSelecionadaId];
  const participanteSelecionado = participantes.find((p) => p.socketId === telaSelecionadaId);

  useEffect(() => {
    telaSelecionadaRef.current = telaSelecionadaId;
    sincronizarAudioDasTelas();
  }, [telaSelecionadaId]);

  useEffect(() => {
    if (!telaSelecionadaId) return;
    const selecaoLocalValida = telaSelecionadaId === socket?.id && compartilhandoTela;
    const selecaoRemotaValida = Boolean(telasRemotas[telaSelecionadaId]);
    if (!selecaoLocalValida && !selecaoRemotaValida) setTelaSelecionadaId(null);
  }, [telaSelecionadaId, socket, compartilhandoTela, telasRemotas]);

  useEffect(() => {
    function sincronizarTelaCheia() {
      setEmTelaCheia(document.fullscreenElement === telaTileRef.current);
    }
    document.addEventListener('fullscreenchange', sincronizarTelaCheia);
    return () => document.removeEventListener('fullscreenchange', sincronizarTelaCheia);
  }, []);

  useEffect(() => {
    setPaginaInteira(false);
  }, [telaSelecionadaId, visible, telaMinimizada]);

  const mostrarMiniPlayer = Boolean(streamSelecionada && (!visible || telaMinimizada));
  if (!visible && !mostrarMiniPlayer) return null;
  const localId = socket?.id || 'local';
  const participantesDoPalco = [...new Map([
    ...participantes.filter((p) => p.socketId !== localId),
    { socketId: localId, nome: nomeUsuario || usuario?.nome || 'Você', avatarCor: usuario?.avatarCor, avatarUrl: usuario?.avatarUrl },
  ].map((p) => [p.socketId, p])).values()];

  const stage = visible && <VoiceCallStage
    canal={canal} participantes={participantesDoPalco} socketId={localId}
    peersRef={conexoesRef}
    micMudo={micMudo} audioMudo={audioMudo} conectando={conectando} connectionState={connectionState}
    erro={erro} avisoMicrofone={avisoMicrofone} erroCompartilhamento={erroCompartilhamento} compartilhamentoPendente={compartilhamentoPendente}
    compartilhandoTela={compartilhandoTela} streamSelecionada={mostrarMiniPlayer ? null : streamSelecionada}
    telaSelecionadaId={mostrarMiniPlayer ? null : telaSelecionadaId} telaLocalSelecionada={telaLocalSelecionada}
    participanteSelecionado={participanteSelecionado} telasRemotas={telasRemotas}
    streamLocal={compartilhandoTela ? telaLocalRef.current : null}
    telaTileRef={telaTileRef} emTelaCheia={emTelaCheia || paginaInteira} paginaInteira={paginaInteira} telasMutadas={telasMutadas} volumesTelas={volumesTelas}
    onAlternarMic={alternarMudo} onAlternarAudio={alternarAudio}
    onCompartilharTela={onCompartilharTela} onPararCompartilhamento={pararCompartilhamento}
    onDesconectar={onDesconectar} onAbrirConfiguracoes={onAbrirConfiguracoes}
    onAbrirConversa={onAbrirConversa}
    onSelecionarTela={alternarTransmissao} onFecharTela={() => setTelaSelecionadaId(null)}
    onMinimizarTela={() => setTelaMinimizada(true)}
    onTelaCheia={abrirTelaCheia} onMutarTela={alternarMuteTela} onVolumeTela={alterarVolumeTela}
  />;
  return <>
    {stage && (stageContainer === undefined ? stage : stageContainer ? createPortal(stage, stageContainer) : null)}
    {mostrarMiniPlayer && <VoiceMiniPlayer
      stream={streamSelecionada} name={telaLocalSelecionada ? 'Sua tela' : participanteSelecionado?.nome || 'Transmissão'}
      channel={canal.nome} local={telaLocalSelecionada} muted={telasMutadas.has(telaSelecionadaId)}
      position={posicaoMiniPlayer} setPosition={setPosicaoMiniPlayer}
      onRestore={() => { setTelaMinimizada(false); onAbrirChamada?.(); }}
      onMute={() => alternarMuteTela(telaSelecionadaId)}
      onClose={() => setTelaSelecionadaId(null)}
    />}
  </>;
});

export default VoiceChannel;
