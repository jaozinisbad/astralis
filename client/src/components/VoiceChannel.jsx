import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { sincronizarReproducaoDasTelas } from '../audioTela.mjs';
import { getCaptureConstraints, getVideoEncodingParameters, resolveStreamQuality } from '../streamQuality.mjs';

// Servidores STUN públicos e gratuitos do Google — ajudam os dois lados
// a descobrirem como se alcançar através da internet (NAT traversal).
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// O perfil de captura e o teto de bitrate vêm do seletor compartilhado
// com as salas; cada conexão P2P recebe o limite calculado para esse perfil.
// Bitrate de áudio mais alto que o padrão do Opus (que gira uns 32kbps)
// — com um microfone bom, vale a pena usar mais banda pra manter a
// clareza da voz.
const BITRATE_AUDIO = 128_000;

// O áudio do sistema (jogo, música, etc.) se beneficia de mais banda
// ainda que a voz, já que costuma ter mais variação de frequência.
const BITRATE_AUDIO_TELA = 128_000;

// O WebRTC não deixa escolher "use o NVENC" diretamente — quem decide
// usar a placa de vídeo pra codificar é o próprio Chromium, por baixo
// dos panos. O que dá pra fazer é aumentar bastante a chance disso
// acontecer: o H264 é o codec que o Chromium consegue acelerar por
// hardware (via NVENC em GPUs NVIDIA); o VP8, escolha padrão do WebRTC,
// normalmente roda só por software. Então priorizamos H264 ao
// compartilhar tela.
function preferirH264(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;

  const capacidades = RTCRtpSender.getCapabilities('video');
  if (!capacidades) return;

  const h264 = capacidades.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  const outros = capacidades.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
  if (h264.length === 0) return;

  try {
    transceiver.setCodecPreferences([...h264, ...outros]);
  } catch (err) {
    // Se falhar por qualquer motivo, segue com o codec padrão — não é crítico.
  }
}

// Esse componente não controla mais sua própria interface de
// participantes/botões — isso agora vive na barra lateral (para ficar
// igual ao Discord). Em vez disso, ele expõe funções via ref (mutar,
// compartilhar tela, etc.) e avisa o componente pai sempre que o estado
// muda, através de onEstadoChange. O que ele ainda renderiza sozinho são
// só o vídeo que a pessoa selecionou pelo indicador "AO VIVO".
const VoiceChannel = forwardRef(function VoiceChannel(
  { canal, socket, nomeUsuario, onDesconectar, onEstadoChange },
  ref
) {
  const [participantes, setParticipantes] = useState([]); // [{socketId, nome}]
  const [micMudo, setMicMudo] = useState(false);
  const [audioMudo, setAudioMudo] = useState(false);
  const [erro, setErro] = useState('');
  const [erroCompartilhamento, setErroCompartilhamento] = useState('');
  const [telasMutadas, setTelasMutadas] = useState(() => new Set());
  const [volumesTelas, setVolumesTelas] = useState({});
  const [telaSelecionadaId, setTelaSelecionadaId] = useState(null);
  const [emTelaCheia, setEmTelaCheia] = useState(false);
  const [conectando, setConectando] = useState(true);
  const [compartilhandoTela, setCompartilhandoTela] = useState(false);
  const [resolucaoTela, setResolucaoTela] = useState('1080p');
  const [fpsTela, setFpsTela] = useState('60');
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
  const filtroRuidoRef = useRef(null);

  const telaLocalRef = useRef(null);
  const telaTileRef = useRef(null);
  const resolucaoTelaAtualRef = useRef('1080p'); // pra saber o alvo de bitrate ao (re)equilibrar entre espectadores
  const qualidadeTelaAtualRef = useRef(resolveStreamQuality());
  const avisouFalhaQualidadeRef = useRef(false);
  const pipelineAudioProcessoRef = useRef(null); // { stream, receberChunk, destruir } quando usando audio por app
  const pararOuvinteAudioTelaRef = useRef(null); // funcao pra parar de escutar os chunks vindos do Electron
  const conexoesRef = useRef({}); // socketId -> RTCPeerConnection
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
  function bitratePorEspectador(res) {
    const numEspectadores = Math.max(1, Object.keys(conexoesRef.current).length);
    return getVideoEncodingParameters({ ...qualidadeTelaAtualRef.current, resolution: res }, numEspectadores).maxBitrate;
  }

  function aplicarQualidadeVideo(remetente, res, { fps, escala } = {}) {
    const parametros = remetente.getParameters();
    const encodings = parametros.encodings?.length ? parametros.encodings : [{}];
    parametros.encodings = encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: bitratePorEspectador(res),
      ...(fps === undefined ? {} : { maxFramerate: fps }),
      ...(escala === undefined ? {} : { scaleResolutionDownBy: escala }),
    }));
    parametros.degradationPreference = 'maintain-resolution';
    remetente.setParameters(parametros).catch(() => {
      if (avisouFalhaQualidadeRef.current) return;
      avisouFalhaQualidadeRef.current = true;
      setErroCompartilhamento('O navegador não aplicou o limite de bitrate solicitado; a transmissão continuará, mas pode ficar abaixo do perfil escolhido.');
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
      aplicarQualidadeVideo(remetente, resolucaoTelaAtualRef.current);
    });
  }

  // Avisa o App sempre que algo que a sidebar precisa mostrar mudar.
  useEffect(() => {
    const telasAtivas = Object.keys(telasRemotas);
    if (compartilhandoTela && socket?.id) telasAtivas.push(socket.id);
    onEstadoChange?.({
      participantes,
      micMudo,
      audioMudo,
      compartilhandoTela,
      telasAtivas,
      telaSelecionadaId,
      erro,
      erroCompartilhamento,
      conectando,
    });
  }, [participantes, micMudo, audioMudo, compartilhandoTela, telasRemotas, telaSelecionadaId, socket, erro, erroCompartilhamento, conectando]);

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

  // Monta o pipeline microfone -> ganho -> stream de saída. Usado tanto
  // ao entrar na call quanto ao trocar de microfone no meio dela.
  //
  // CORREÇÃO: agora pedimos explicitamente cancelamento de eco, supressão
  // de ruído e controle automático de ganho (antes ficava só no padrão
  // "cru" do sistema, o que deixava ruído externo vazar mais), e também
  // respeitamos o microfone escolhido nas Configurações — antes o app
  // sempre usava o microfone padrão do Windows, ignorando a escolha.
  async function montarPipelineDeEntrada(deviceId) {
    const config = configuracaoAudioRef.current;
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
      if (err.name !== 'OverconstrainedError' || !deviceId) throw err;

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

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const contexto = new AudioContext();
    const origem = contexto.createMediaStreamSource(streamBruta);
    const ganho = contexto.createGain();
    ganho.gain.value = (configuracaoAudioRef.current.volumeEntrada ?? 100) / 100;
    const destino = contexto.createMediaStreamDestination();
    let filtro = null;
    if (usarRnnoise) {
      try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const estado = rnnoise.createDenoiseState();
        const processador = contexto.createScriptProcessor(1024, 1, 1);
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
        origem.connect(processador).connect(ganho);
        filtro = { destruir: () => { processador.disconnect(); estado.destroy(); } };
      } catch (err) {
        // A supressão nativa continua ativa se o WebAssembly não puder carregar.
        origem.connect(ganho);
      }
    } else {
      origem.connect(ganho);
    }
    ganho.connect(destino);

    streamLocalRef.current = streamBruta;
    streamEnviadaRef.current = destino.stream;
    contextoEntradaRef.current = contexto;
    ganhoEntradaRef.current = ganho;
    filtroRuidoRef.current = filtro;

    streamBruta.getAudioTracks().forEach((t) => (t.enabled = !micMudo));

    return destino.stream.getAudioTracks()[0];
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

  // Converte os pedaços de áudio cru (PCM 16-bit, estéreo, 48kHz) que o
  // processo principal do Electron manda via IPC — vindos da captura de
  // um app específico — num MediaStream de verdade, que o WebRTC
  // consegue enviar pros outros participantes. Usa um ScriptProcessorNode
  // (mais simples de implementar que um AudioWorklet) que vai "puxando"
  // amostras de uma fila conforme o áudio toca.
  function criarPipelineDeAudioPorProcesso() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const contexto = new AudioContext({ sampleRate: 48000 });
    const destino = contexto.createMediaStreamDestination();

    const filaEsquerda = [];
    const filaDireita = [];
    const TAMANHO_MAXIMO_FILA = 48000 * 2; // ~2 segundos de margem de segurança

    // 4096 amostras por bloco, 0 canais de entrada (não vem do
    // microfone), 2 canais de saída (estéreo).
    const processador = contexto.createScriptProcessor(4096, 0, 2);
    processador.onaudioprocess = (evento) => {
      const saidaEsquerda = evento.outputBuffer.getChannelData(0);
      const saidaDireita = evento.outputBuffer.getChannelData(1);
      for (let i = 0; i < saidaEsquerda.length; i++) {
        saidaEsquerda[i] = filaEsquerda.length ? filaEsquerda.shift() : 0;
        saidaDireita[i] = filaDireita.length ? filaDireita.shift() : 0;
      }
    };
    processador.connect(destino);

    function receberChunk(chunkBuffer) {
      // chunkBuffer: PCM 16-bit assinado, estéreo, intercalado (LRLRLR...)
      const bytes = new Uint8Array(chunkBuffer);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const totalAmostras = Math.floor(bytes.length / 4); // 2 bytes x 2 canais por amostra

      for (let i = 0; i < totalAmostras; i++) {
        const offset = i * 4;
        const amostraEsquerda = view.getInt16(offset, true) / 32768;
        const amostraDireita = view.getInt16(offset + 2, true) / 32768;
        if (filaEsquerda.length < TAMANHO_MAXIMO_FILA) filaEsquerda.push(amostraEsquerda);
        if (filaDireita.length < TAMANHO_MAXIMO_FILA) filaDireita.push(amostraDireita);
      }
    }

    return {
      stream: destino.stream,
      receberChunk,
      destruir: () => {
        processador.disconnect();
        contexto.close().catch(() => {});
      },
    };
  }

  useEffect(() => {
    if (!socket) return;
    let cancelado = false;

    async function renegociar(pc, socketId) {
      const oferta = await pc.createOffer();
      await pc.setLocalDescription(oferta);
      socket.emit('webrtc-oferta', { para: socketId, oferta });
    }

    function criarConexao(socketId) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      conexoesRef.current[socketId] = pc;

      streamEnviadaRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, streamEnviadaRef.current);
      });
      configurarQualidadeDeAudio(pc);

      telaLocalRef.current?.getTracks().forEach((track) => {
        const remetente = pc.addTrack(track, telaLocalRef.current);
        if (track.kind === 'video') {
          const transceiver = pc.getTransceivers().find((t) => t.sender === remetente);
          preferirH264(transceiver);
          aplicarQualidadeVideo(remetente, resolucaoTelaAtualRef.current);
        }
      });
      // O áudio "só desse app" (captura por processo) NÃO faz parte do
      // stream de telaLocalRef — ele vem de um pipeline (Web Audio)
      // completamente separado. Por isso o forEach acima nunca pega ele:
      // quem já estava na call quando o compartilhamento começou recebe
      // esse áudio (é adicionado manualmente em iniciarCompartilhamento),
      // mas quem entra na call DEPOIS ficava sem, porque essa conexão
      // nova só via os tracks de telaLocalRef. Corrigido adicionando esse
      // áudio aqui também, se tiver um em andamento.
      const audioTrackProcesso = pipelineAudioProcessoRef.current?.stream.getAudioTracks()[0];
      if (audioTrackProcesso) {
        const remetenteAudio = pc.addTrack(audioTrackProcesso, telaLocalRef.current);
        const parametrosAudio = remetenteAudio.getParameters();
        parametrosAudio.encodings = (parametrosAudio.encodings?.length ? parametrosAudio.encodings : [{}]).map(
          (encoding) => ({ ...encoding, maxBitrate: BITRATE_AUDIO_TELA }),
        );
        remetenteAudio.setParameters(parametrosAudio).catch(() => {});
      }
      // Chegou mais um espectador: reequilibra o bitrate de quem já estava
      // vendo, já que agora a banda de upload precisa ser dividida entre
      // mais gente.
      if (telaLocalRef.current) queueMicrotask(() => reaplicarBitrateTela());

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('webrtc-candidato', { para: socketId, candidato: e.candidate });
        }
      };

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
              ? audioMudoRef.current || telasMutadasRef.current.has(socketId) || telaSelecionadaRef.current !== socketId
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
          setTelasRemotas((atual) => ({ ...atual, [socketId]: e.streams[0] }));
          e.track.onended = () => {
            setTelasRemotas((atual) => {
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
      conexoesRef.current[socketId]?.close();
      delete conexoesRef.current[socketId];
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
      try {
        await montarPipelineDeEntrada(configuracaoAudioRef.current.microfoneId);
        if (cancelado) return;
        setConectando(false);
        socket.emit('entrar-canal-voz', canal.id);
      } catch (err) {
        const mensagem = err.name === 'NotFoundError'
          ? 'Nenhum microfone foi encontrado neste computador.'
          : err.name === 'NotAllowedError' || err.name === 'SecurityError'
            ? 'O acesso ao microfone foi bloqueado. Verifique as permissões do Windows.'
            : err.name === 'OverconstrainedError'
              ? 'O microfone selecionado não está disponível. Escolha outro nas configurações de áudio.'
              : 'Não foi possível acessar o microfone. Verifique as configurações de áudio.';
        setErro(mensagem);
        setConectando(false);
      }
    }

    socket.on('peers-existentes', ({ peers }) => {
      setParticipantes([
        ...peers,
        { socketId: socket.id, nome: nomeUsuario },
      ]);
      peers.forEach((p) => {
        const pc = criarConexao(p.socketId);
        renegociar(pc, p.socketId);
      });
    });

    socket.on('novo-peer', ({ socketId, nome, avatarCor, avatarUrl }) => {
      tocarEfeito('entrar');
      setParticipantes((atual) => [...atual, { socketId, nome, avatarCor: avatarCor || '#5865f2', avatarUrl: avatarUrl || null }]);
    });

    socket.on('webrtc-oferta', async ({ de, oferta }) => {
      const conexaoNova = !conexoesRef.current[de];
      const pc = conexoesRef.current[de] || criarConexao(de);
      await pc.setRemoteDescription(oferta);
      const resposta = await pc.createAnswer();
      await pc.setLocalDescription(resposta);
      socket.emit('webrtc-resposta', { para: de, resposta });

      // Se é uma conexão nova (alguém acabou de entrar na call) e eu já
      // estou compartilhando tela: a track de vídeo foi adicionada na
      // criarConexao(), mas não pôde entrar nessa resposta, porque a
      // resposta só "fala" sobre o que a oferta recebida pediu (só
      // áudio, no caso de quem chega). Por isso mandamos uma segunda
      // oferta logo em seguida, dessa vez incluindo o vídeo — sem isso,
      // quem entra depois só veria a tela se a pessoa reiniciasse o
      // compartilhamento.
      if (conexaoNova && telaLocalRef.current) {
        await renegociar(pc, de);
      }
    });

    socket.on('webrtc-resposta', async ({ de, resposta }) => {
      const pc = conexoesRef.current[de];
      if (pc) await pc.setRemoteDescription(resposta);
    });

    socket.on('webrtc-candidato', async ({ de, candidato }) => {
      const pc = conexoesRef.current[de];
      if (pc) {
        try {
          await pc.addIceCandidate(candidato);
        } catch (e) {
          // candidato pode chegar antes da remote description em alguns casos; ignora
        }
      }
    });

    socket.on('peer-saiu', ({ socketId }) => {
      tocarEfeito('sair');
      telasComSomRef.current.delete(socketId);
      fecharConexao(socketId);
      setParticipantes((atual) => atual.filter((p) => p.socketId !== socketId));
    });

    socket.on('tela-parada', ({ socketId }) => {
      removerTelaRemota(socketId);
    });

    iniciar();

    return () => {
      cancelado = true;
      socket.emit('sair-canal-voz');
      socket.off('peers-existentes');
      socket.off('novo-peer');
      socket.off('webrtc-oferta');
      socket.off('webrtc-resposta');
      socket.off('webrtc-candidato');
      socket.off('peer-saiu');
      socket.off('tela-parada');

      Object.keys(conexoesRef.current).forEach(fecharConexao);
      streamLocalRef.current?.getTracks().forEach((t) => t.stop());
      streamLocalRef.current = null;
      streamEnviadaRef.current = null;
      filtroRuidoRef.current?.destruir();
      filtroRuidoRef.current = null;
      contextoEntradaRef.current?.close().catch(() => {});
      contextoEntradaRef.current = null;
      telaLocalRef.current?.getTracks().forEach((t) => t.stop());
      telaLocalRef.current = null;
      if (pipelineAudioProcessoRef.current) {
        pipelineAudioProcessoRef.current.destruir();
        pipelineAudioProcessoRef.current = null;
      }
      if (pararOuvinteAudioTelaRef.current) {
        pararOuvinteAudioTelaRef.current();
        pararOuvinteAudioTelaRef.current = null;
      }
      window.electronAPI?.pararCapturaProcesso?.();
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
    sincronizarAudioDasTelas();
    setAudioMudo(novoEstado);
  }

  async function renegociarComTodos() {
    for (const [socketId, pc] of Object.entries(conexoesRef.current)) {
      const oferta = await pc.createOffer();
      await pc.setLocalDescription(oferta);
      socket.emit('webrtc-oferta', { para: socketId, oferta });
    }
  }

  // CORREÇÃO DO BUG "sempre compartilha o monitor 1": antes de chamar
  // getDisplayMedia(), avisamos o processo principal do Electron qual
  // fonte foi escolhida no seletor — sem isso, o Electron sempre decidia
  // sozinho (e sempre escolhia a primeira tela da lista).
  async function iniciarCompartilhamento(config) {
    try {
      setErroCompartilhamento('');
      avisouFalhaQualidadeRef.current = false;
      const qualidade = resolveStreamQuality({
        ...config,
        resolution: config?.resolution ?? config?.resolucao ?? resolucaoTela,
        fps: config?.fps ?? Number(fpsTela),
      });
      const res = qualidade.resolution;
      const fps = qualidade.fps;
      const dimensoes = res === '1080p'
        ? { largura: 1920, altura: 1080 }
        : { largura: 1280, altura: 720 };

      const usarCapturaCompativel = config?.modoCaptura === 'compatibilidade' && config?.fonteId;
      if (!usarCapturaCompativel && config?.fonteId && window.electronAPI?.definirFonteCompartilhamento) {
        window.electronAPI.definirFonteCompartilhamento(config.fonteId);
      }

      // Se o usuário marcou "capturar só o áudio desse app", não pedimos
      // o loopback do sistema inteiro no getDisplayMedia — em vez disso,
      // usamos a captura por processo específico do Electron. O mesmo
      // vale pra "ignorar um app no áudio" (ex: Discord) — nos dois
      // casos quem manda o áudio de verdade é o pipeline por processo,
      // não o getDisplayMedia.
      const usarAudioPorApp = !!config?.capturarAudioApp && !!config?.tituloJanela;
      const usarAudioIgnorandoApp = Boolean(config?.ignorarProcessoAudio || config?.ignoreDiscordAudio);

      const stream = usarCapturaCompativel
        ? await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: config.fonteId,
              minWidth: dimensoes.largura,
              maxWidth: dimensoes.largura,
              minHeight: dimensoes.altura,
              maxHeight: dimensoes.altura,
              minFrameRate: fps,
              maxFrameRate: fps,
            },
          },
        })
        : await navigator.mediaDevices.getDisplayMedia({
          video: getCaptureConstraints(qualidade).video,
          audio: Boolean(qualidade.shareAudio && !usarAudioPorApp && !usarAudioIgnorandoApp),
        });

      const videoTrack = stream.getVideoTracks()[0];
      let audioTrackTela = stream.getAudioTracks()[0]; // pode não vir, dependendo do sistema
      // "motion" faz o codec priorizar fluidez durante movimento rápido
      // (jogo em ação) em vez de nitidez de imagem parada — era "detail"
      // antes, o que é ótimo pra compartilhar texto/planilha parada, mas
      // é exatamente o motivo da imagem borrar quando o jogo se move
      // rápido: o encoder estava gastando bits tentando preservar
      // detalhe estático em vez de acompanhar o movimento.
      videoTrack.contentHint = qualidade.contentType;
      videoTrack.onended = () => pararCompartilhamento();

      telaLocalRef.current = stream;
      resolucaoTelaAtualRef.current = res;
      qualidadeTelaAtualRef.current = qualidade;
      setResolucaoTela(res);
      setFpsTela(String(fps));
      setCompartilhandoTela(true);
      tocarEfeito('transmitir');

      if (usarAudioPorApp) {
        const resultado = await window.electronAPI?.iniciarCapturaProcesso(config.tituloJanela);
        if (resultado?.sucesso) {
          const pipeline = criarPipelineDeAudioPorProcesso();
          pipelineAudioProcessoRef.current = pipeline;
          pararOuvinteAudioTelaRef.current = window.electronAPI.onAudioTelaChunk(pipeline.receberChunk);
          audioTrackTela = pipeline.stream.getAudioTracks()[0];
        } else {
          // Não é motivo pra cancelar a transmissão inteira — só avisa
          // que vai sem áudio isolado dessa vez.
          setErroCompartilhamento(
            `Não consegui capturar o áudio só desse app (${resultado?.mensagem || 'motivo desconhecido'}). Compartilhando sem esse áudio específico.`,
          );
          audioTrackTela = null;
        }
      } else if (usarAudioIgnorandoApp) {
        const nomeProcesso = config?.nomeProcessoIgnorado || 'Discord.exe';
        const resultado = await window.electronAPI?.iniciarCapturaExcluindoProcesso(nomeProcesso);
        if (resultado?.sucesso) {
          const pipeline = criarPipelineDeAudioPorProcesso();
          pipelineAudioProcessoRef.current = pipeline;
          pararOuvinteAudioTelaRef.current = window.electronAPI.onAudioTelaChunk(pipeline.receberChunk);
          audioTrackTela = pipeline.stream.getAudioTracks()[0];
        } else {
          setErroCompartilhamento(
            `Não consegui ignorar o ${nomeProcesso} no áudio (${resultado?.mensagem || 'motivo desconhecido'}). A transmissão seguirá sem áudio do sistema.`,
          );
          audioTrackTela = null;
        }
      }

      const alturaNativa = videoTrack.getSettings().height || dimensoes.altura;
      const alturaAlvo = res === '1080p' ? 1080 : 720;
      const escala = alturaNativa > alturaAlvo ? alturaNativa / alturaAlvo : 1;

      Object.values(conexoesRef.current).forEach((pc) => {
        const remetente = pc.addTrack(videoTrack, stream);
        const transceiver = pc.getTransceivers().find((t) => t.sender === remetente);
        preferirH264(transceiver);

        // Se a conexão apertar, prefere cair o FPS a perder nitidez de
        // resolução — pra manter a imagem legível mesmo com engasgo.
        aplicarQualidadeVideo(remetente, res, { fps, escala });

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
      setErroCompartilhamento(
        err?.name === 'AbortError'
          ? 'Compartilhamento de tela cancelado.'
          : 'Não foi possível compartilhar a tela. Verifique as permissões do sistema.',
      );
    }
  }

  async function pararCompartilhamento() {
    const stream = telaLocalRef.current;
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrackSistema = stream.getAudioTracks()[0];
    const audioTrackProcesso = pipelineAudioProcessoRef.current?.stream.getAudioTracks()[0];

    Object.values(conexoesRef.current).forEach((pc) => {
      pc.getSenders().forEach((remetente) => {
        if (
          remetente.track === videoTrack ||
          (audioTrackSistema && remetente.track === audioTrackSistema) ||
          (audioTrackProcesso && remetente.track === audioTrackProcesso)
        ) {
          pc.removeTrack(remetente);
        }
      });
    });

    socket.emit('tela-parada');
    stream.getTracks().forEach((t) => t.stop());
    telaLocalRef.current = null;

    if (pipelineAudioProcessoRef.current) {
      pipelineAudioProcessoRef.current.destruir();
      pipelineAudioProcessoRef.current = null;
    }
    if (pararOuvinteAudioTelaRef.current) {
      pararOuvinteAudioTelaRef.current();
      pararOuvinteAudioTelaRef.current = null;
    }
    window.electronAPI?.pararCapturaProcesso?.();

    setCompartilhandoTela(false);
    await renegociarComTodos();
  }

  async function abrirTelaCheia() {
    try {
      const elemento = telaTileRef.current;
      if (!elemento) {
        throw new Error('Painel da transmissão não encontrado.');
      }
      if (document.fullscreenElement === elemento) {
        await document.exitFullscreen();
      } else {
        await elemento.requestFullscreen();
      }
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
    const precisaReconstruirEntrada = ['microfoneId', 'perfilEntrada', 'supressaoRuido', 'cancelamentoEco', 'ganhoAutomatico']
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
      try {
        streamLocalRef.current.getTracks().forEach((t) => t.stop());
        filtroRuidoRef.current?.destruir();
        filtroRuidoRef.current = null;
        contextoEntradaRef.current?.close().catch(() => {});
        const novaTrackEnviada = await montarPipelineDeEntrada(config.microfoneId);

        Object.values(conexoesRef.current).forEach((pc) => {
          const remetente = pc.getSenders().find((s) => s.track?.kind === 'audio');
          remetente?.replaceTrack(novaTrackEnviada);
          configurarQualidadeDeAudio(pc);
        });
      } catch (err) {
        setErro('Não foi possível trocar de microfone.');
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
    fecharTransmissao: () => setTelaSelecionadaId(null),
  }));

  function alternarTransmissao(socketId) {
    setTelaSelecionadaId((atual) => atual === socketId ? null : socketId);
  }

  function sincronizarAudioDasTelas() {
    sincronizarReproducaoDasTelas(audiosTelaRef.current, {
      audioMudo: audioMudoRef.current,
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

  if (!streamSelecionada) return null;

  return (
    <div className="content voice-call-panel voice-call-panel--active">
      <div className="content__header voice-call-panel__header">
        <span className="content__channel-symbol">◌</span>
        <span>{canal.nome} — {telaLocalSelecionada ? 'Sua tela' : participanteSelecionado?.nome || 'Transmissão ao vivo'}</span>
        <span className="voice-call-panel__live"><span /> AO VIVO</span>
        <button type="button" className="voice-call-panel__close" onClick={() => setTelaSelecionadaId(null)}>
          Fechar
        </button>
      </div>
      <div className="content__body">
        <div className="telas-compartilhadas">
          <div className="tela-tile" key={telaSelecionadaId} ref={telaTileRef}>
            <video
              autoPlay
              playsInline
              muted
              ref={(el) => {
                if (el) el.srcObject = streamSelecionada;
              }}
            />
            <div className="tela-tile__label">{telaLocalSelecionada ? 'Sua tela (você)' : participanteSelecionado?.nome || 'Alguém'}</div>
            <div className="tela-tile__controls">
              <button
                className="tela-tile__fullscreen"
                onClick={abrirTelaCheia}
                title={emTelaCheia ? 'Sair da tela cheia' : 'Abrir a transmissão em tela cheia'}
                type="button"
              >
                {emTelaCheia ? 'Sair da tela cheia' : 'Tela cheia'}
              </button>
              {!telaLocalSelecionada && (
                <>
                  <label className="tela-tile__volume">
                    <span>Volume {Math.round(volumesTelas[telaSelecionadaId] ?? 100)}%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={volumesTelas[telaSelecionadaId] ?? 100}
                      aria-label={`Volume da transmissão de ${participanteSelecionado?.nome || 'Alguém'}`}
                      onChange={(evento) => alterarVolumeTela(telaSelecionadaId, evento.target.valueAsNumber)}
                    />
                  </label>
                  <button
                    className="tela-tile__mutar"
                    onClick={() => alternarMuteTela(telaSelecionadaId)}
                    title={telasMutadas.has(telaSelecionadaId) ? 'Ativar o áudio dessa tela' : 'Mutar o áudio dessa tela'}
                    type="button"
                  >
                    {telasMutadas.has(telaSelecionadaId) ? 'Ativar som' : 'Silenciar'}
                  </button>
                </>
              )}
              <button
                className="tela-tile__ocultar"
                onClick={() => setTelaSelecionadaId(null)}
                title="Fechar a transmissão sem sair da chamada"
                type="button"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default VoiceChannel;
