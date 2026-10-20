import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import ServerSidebar from './components/ServerSidebar.jsx';
import ChannelSidebar from './components/ChannelSidebar.jsx';
import ChatArea from './components/ChatArea.jsx';
import VoiceChannel from './components/VoiceChannel.jsx';
import VoiceChannelEntry from './components/VoiceChannelEntry.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import AddServerModal from './components/AddServerModal.jsx';
import ProfileModal from './components/ProfileModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import ScreenShareSourcePicker from './components/ScreenShareSourcePicker.jsx';
import FriendsScreen from './components/FriendsScreen.jsx';
import DirectMessageScreen from './components/DirectMessageScreen.jsx';
import ServerSettingsModal from './components/ServerSettingsModal.jsx';
import CreateChannelModal from './components/CreateChannelModal.jsx';
import MemberSidebar from './components/MemberSidebar.jsx';
import RoomLobby from './components/RoomLobby.jsx';
import StreamRoom from './components/StreamRoom.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import { SERVER_URL, apiFetch } from './api.js';
import { getScreenCaptureWarning, requestScreenCapture, stopScreenCapture } from './screenCapture.mjs';
import { emitirSolicitacaoSala } from './roomSocket.mjs';
import HomeSidebar, { WorkspaceIcon } from './components/HomeSidebar.jsx';
import DesktopTitlebar from './components/DesktopTitlebar.jsx';
import { applyInterfacePreferences, useInterfacePreferences } from './interfacePreferences.mjs';
import { useFriends } from './useFriends.mjs';
import { useDirectCall } from './useDirectCall.mjs';
import DirectCallNotice from './components/DirectCallNotice.jsx';

export default function App() {
  const [interfacePreferences] = useInterfacePreferences();
  useEffect(() => { applyInterfacePreferences(interfacePreferences); }, [interfacePreferences]);
  return (
    <div className="app-shell">
      <DesktopTitlebar />
      <UpdateBanner />
      <div className="app-shell__content"><AppContent /></div>
    </div>
  );
}

function AppContent() {
  const [sessao, setSessao] = useState(() => {
    const salvo = localStorage.getItem('sessao');
    return salvo ? JSON.parse(salvo) : null;
  });
  const [status, setStatus] = useState('conectando...');
  const [socket, setSocket] = useState(null);
  const [guestLoginOpen, setGuestLoginOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [membrosVisiveis, setMembrosVisiveis] = useState(true);
  const [activeRoom, setActiveRoom] = useState(() => {
    const params = new URLSearchParams(globalThis.window?.location?.search || '');
    const roomId = params.get('room');
    return roomId ? { roomId, role: 'viewer', joinedInitially: false, accessCode: params.get('code') || '' } : null;
  });
  const [screenStream, setScreenStream] = useState(null);
  const [screenQuality, setScreenQuality] = useState(null);
  const [captureError, setCaptureError] = useState('');
  const pedidoCapturaRef = useRef(0);
  const controladorCapturaRef = useRef(null);
  const screenStreamRef = useRef(null);

  function cancelarPedidoCaptura() {
    pedidoCapturaRef.current += 1;
    controladorCapturaRef.current?.abort();
    controladorCapturaRef.current = null;
  }

  useEffect(() => () => {
    cancelarPedidoCaptura();
    stopScreenCapture(screenStreamRef.current).catch(() => {});
    screenStreamRef.current = null;
  }, []);

  const [servidores, setServidores] = useState([]);
  const [servidoresCarregando, setServidoresCarregando] = useState(() => !!sessao);
  const [erroServidores, setErroServidores] = useState('');
  const [tentativaServidores, setTentativaServidores] = useState(0);
  const [servidorAtivoId, setServidorAtivoId] = useState(null);
  const [canais, setCanais] = useState([]);
  const [canaisCarregando, setCanaisCarregando] = useState(false);
  const [canaisServidorId, setCanaisServidorId] = useState(null);
  const [erroCanais, setErroCanais] = useState('');
  const [tentativaCanais, setTentativaCanais] = useState(0);
  const [membrosServidor, setMembrosServidor] = useState([]);
  const [cargosServidor, setCargosServidor] = useState([]);
  const [canalAtivo, setCanalAtivo] = useState(null);
  const [canalDeVoz, setCanalDeVoz] = useState(null);
  const canalRetornoRef = useRef(null);
  const [vozEstado, setVozEstado] = useState({
    participantes: [],
    micMudo: false,
    audioMudo: false,
    compartilhandoTela: false,
    telasAtivas: [],
    telaSelecionadaId: null,
    erro: '',
    erroCompartilhamento: '',
    conectando: true,
  });
  const voiceChannelRef = useRef(null);
  const [modalAberto, setModalAberto] = useState(false);
  const [perfilAberto, setPerfilAberto] = useState(false);
  const [settingsAberto, setSettingsAberto] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState('account');
  const [servidorConfiguracaoAberto, setServidorConfiguracaoAberto] = useState(false);
  const [criacaoCanal, setCriacaoCanal] = useState(null);
  const [pickerTelaAberto, setPickerTelaAberto] = useState(false);
  const [pickerContexto, setPickerContexto] = useState('call');

  // view: 'servidor' | 'amigos' | 'dm' | 'chamada-direta'
  const [view, setView] = useState(() => activeRoom
    || new URLSearchParams(globalThis.window?.location?.search || '').get('view') === 'salas'
    ? 'salas' : 'amigos');
  const [dmAtiva, setDmAtiva] = useState(null); // amigo com quem está conversando
  const friendships = useFriends(sessao?.token, socket);
  const { amigos } = friendships;
  const directCall = useDirectCall({
    socket, usuarioId: sessao?.usuario.id,
    onActive(call) {
      const friend = String(call.caller.id) === String(sessao?.usuario.id) ? call.callee : call.caller;
      if (activeRoom) fecharSala();
      setDmAtiva({ ...friend, online: true });
      setCanalDeVoz({ id: call.canalId, tipo: 'voz', nome: friend.nome, direta: true, callId: call.id, amigo: friend });
      setMobileNavigationOpen(false);
      setView('chamada-direta');
    },
    onEnded(callId) {
      setCanalDeVoz(current => current?.callId === callId ? null : current);
      setVozEstado(current => ({ ...current, telasAtivas: [], compartilhandoTela: false, telaSelecionadaId: null }));
      setPickerTelaAberto(false);
      setView(current => current === 'chamada-direta' ? 'dm' : current);
    },
  });
  const dmAtual = amigos.find(friend => String(friend.id) === String(dmAtiva?.id)) || dmAtiva;

  useEffect(() => {
    const settings = () => setSettingsAberto(true);
    const keyboard = (event) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); settings(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (activeRoom) fecharSala();
        setView('amigos');
        setMobileNavigationOpen(true);
        setTimeout(() => window.dispatchEvent(new Event('astralis:focus-search')), 0);
      }
      if (event.key === 'Escape') setMobileNavigationOpen(false);
    };
    window.addEventListener('astralis:open-settings', settings);
    window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('astralis:open-settings', settings); window.removeEventListener('keydown', keyboard); };
  }, [activeRoom]);

  // Quem está em cada canal de voz, de TODOS os servidores já vistos —
  // canalId -> [{socketId, nome, avatarCor, avatarUrl}]. Isso alimenta a
  // pré-visualização de participantes mesmo sem você estar na call.
  const [presencaVoz, setPresencaVoz] = useState({});

  useEffect(() => {
    function aoInvalidarSessao() {
      sair();
    }
    window.addEventListener('sessao-invalida', aoInvalidarSessao);
    return () => window.removeEventListener('sessao-invalida', aoInvalidarSessao);
  }, []);

  // Conecta o socket para os anfitriões autenticados e espectadores sem conta.
  useEffect(() => {
    const s = io(SERVER_URL, {
      auth: sessao ? { token: sessao.token } : { modo: 'espectador' },
      // Faz o ngrok (plano grátis) pular a página de aviso de navegador.
      // Inofensivo em outros túneis/hosts, que simplesmente ignoram o header.
      extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
    });
    s.on('connect', () => setStatus('conectado ao servidor'));
    s.on('disconnect', () => setStatus('desconectado'));
    setSocket(s);
    return () => s.disconnect();
  }, [sessao]);

  // Carrega os servidores do usuário assim que loga.
  useEffect(() => {
    let ativo = true;
    if (!sessao) {
      setServidoresCarregando(false);
      setErroServidores('');
      return () => { ativo = false; };
    }

    setServidoresCarregando(true);
    setErroServidores('');
    apiFetch('/api/servidores', sessao.token)
      .then((lista) => {
        if (!ativo) return;
        setServidores(lista);
        setServidorAtivoId(lista[0]?.id ?? null);
      })
      .catch((erro) => {
        if (!ativo) return;
        setErroServidores(erro.message || 'Não foi possível carregar seus servidores.');
      })
      .finally(() => {
        if (ativo) setServidoresCarregando(false);
      });
    return () => { ativo = false; };
  }, [sessao, tentativaServidores]);

  // Atualiza a lista de amigos em tempo real quando alguém fica online/offline
  // (sem precisar recarregar tudo do zero a cada evento).
  useEffect(() => {
    if (!socket) return;
    function offline({ usuarioId }) {
      setMembrosServidor((atual) => atual.map((m) => (m.id === usuarioId ? { ...m, online: false } : m)));
    }
    function membroOnline({ usuarioId }) {
      setMembrosServidor((atual) => atual.map((m) => (m.id === usuarioId ? { ...m, online: true } : m)));
    }
    socket.on('amigo-offline', offline);
    socket.on('amigo-online', membroOnline);

    function aoAtualizarPresencaVoz({ canalId, participantes }) {
      setPresencaVoz((atual) => ({ ...atual, [canalId]: participantes }));
    }
    socket.on('presenca-voz-canal', aoAtualizarPresencaVoz);

    function aoSerExpulsoDaCall() {
      desconectarVoz();
    }
    socket.on('voce-foi-expulso-da-call', aoSerExpulsoDaCall);

    return () => {
      socket.off('amigo-offline', offline);
      socket.off('amigo-online', membroOnline);
      socket.off('presenca-voz-canal', aoAtualizarPresencaVoz);
      socket.off('voce-foi-expulso-da-call', aoSerExpulsoDaCall);
    };
  }, [socket]);

  // Pede o retrato inicial de quem está em cada canal de voz do servidor
  // ativo, assim que o socket e o servidor estiverem prontos — as
  // atualizações seguintes chegam em tempo real pelo listener acima.
  useEffect(() => {
    if (!socket || !servidorAtivoId) return;
    function aoReceberRetrato({ participantesPorCanal }) {
      setPresencaVoz((atual) => ({ ...atual, ...participantesPorCanal }));
    }
    socket.once('presenca-voz-servidor', aoReceberRetrato);
    socket.emit('obter-presenca-servidor', servidorAtivoId);
    return () => socket.off('presenca-voz-servidor', aoReceberRetrato);
  }, [socket, servidorAtivoId]);

  // Carrega os canais sempre que o servidor ativo muda.
  useEffect(() => {
    let ativo = true;
    if (!sessao || !servidorAtivoId) {
      setCanaisCarregando(false);
      setErroCanais('');
      setCanais([]);
      setCanalAtivo(null);
      setCanaisServidorId(null);
      setMembrosServidor([]);
      setCargosServidor([]);
      return () => { ativo = false; };
    }

    setCanaisCarregando(true);
    setErroCanais('');
    setCanais([]);
    setCanalAtivo(null);
    setMembrosServidor([]);
    setCargosServidor([]);
    apiFetch(`/api/servidores/${servidorAtivoId}/canais`, sessao.token)
      .then((lista) => {
        if (!ativo) return;
        setCanais(lista);
        const retorno = canalRetornoRef.current;
        setCanalAtivo(lista.find((canal) => canal.id === retorno?.id) || lista.find((canal) => canal.tipo === 'texto') || lista[0] || null);
        canalRetornoRef.current = null;
      })
      .catch((erro) => {
        if (!ativo) return;
        setErroCanais(erro.message || 'Não foi possível carregar os canais.');
      })
      .finally(() => {
        if (ativo) {
          setCanaisServidorId(servidorAtivoId);
          setCanaisCarregando(false);
        }
      });
    apiFetch(`/api/servidores/${servidorAtivoId}/membros`, sessao.token)
      .then((lista) => { if (ativo) setMembrosServidor(lista); })
      .catch(() => { if (ativo) setMembrosServidor([]); });
    apiFetch(`/api/servidores/${servidorAtivoId}/cargos`, sessao.token)
      .then((lista) => { if (ativo) setCargosServidor(lista); })
      .catch(() => { if (ativo) setCargosServidor([]); });
    return () => { ativo = false; };
  }, [sessao, servidorAtivoId, tentativaCanais]);

  function autenticar(token, usuario) {
    const novaSessao = { token, usuario };
    localStorage.setItem('sessao', JSON.stringify(novaSessao));
    setServidoresCarregando(true);
    setErroServidores('');
    setSessao(novaSessao);
    setGuestLoginOpen(false);
    setView(activeRoom ? 'salas' : 'amigos');
  }

  function sair() {
    fecharSala();
    desconectarVoz();
    localStorage.removeItem('sessao');
    setSocket((atual) => {
      atual?.disconnect();
      return null;
    });
    setSessao(null);
    setServidores([]);
    setServidorAtivoId(null);
    setCanais([]);
    setCanalAtivo(null);
    setPresencaVoz({});
    setMembrosServidor([]);
    setCargosServidor([]);
    setPerfilAberto(false);
    setSettingsAberto(false);
    setServidorConfiguracaoAberto(false);
    setCriacaoCanal(null);
    setPickerTelaAberto(false);
    setModalAberto(false);
    setDmAtiva(null);
    setGuestLoginOpen(false);
    setMobileNavigationOpen(false);
    setView('amigos');
  }

  async function criarServidor(nome) {
    const novo = await apiFetch('/api/servidores', sessao.token, {
      method: 'POST',
      body: JSON.stringify({ nome }),
    });
    setServidores((atual) => [
      ...atual,
      { id: novo.id, nome: novo.nome, codigo_convite: novo.codigo_convite, papel: 'dono' },
    ]);
    setServidorAtivoId(novo.id);
    setView('servidor');
  }

  async function excluirServidor(id) {
    await apiFetch(`/api/servidores/${id}`, sessao.token, { method: 'DELETE' });
    if (servidorAtivoId === id) desconectarVoz();
    setServidores((atual) => {
      const restantes = atual.filter((s) => s.id !== id);
      if (servidorAtivoId === id) {
        setServidorAtivoId(restantes[0]?.id ?? null);
      }
      return restantes;
    });
  }

  async function sairDoServidor(id) {
    await apiFetch(`/api/servidores/${id}/sair`, sessao.token, { method: 'POST' });
    if (servidorAtivoId === id) desconectarVoz();
    setServidores((atual) => {
      const restantes = atual.filter((s) => s.id !== id);
      if (servidorAtivoId === id) {
        setServidorAtivoId(restantes[0]?.id ?? null);
      }
      return restantes;
    });
  }

  async function entrarComCodigo(codigo) {
    const servidor = await apiFetch('/api/servidores/entrar', sessao.token, {
      method: 'POST',
      body: JSON.stringify({ codigo }),
    });
    const lista = await apiFetch('/api/servidores', sessao.token);
    setServidores(lista);
    setServidorAtivoId(servidor.id);
    setView('servidor');
  }

  async function salvarPerfil(dados) {
    const atualizado = await apiFetch('/api/perfil', sessao.token, {
      method: 'PATCH',
      body: JSON.stringify(dados),
    });
    const novaSessao = { token: atualizado.token, usuario: atualizado.usuario };
    localStorage.setItem('sessao', JSON.stringify(novaSessao));
    setSessao(novaSessao);
  }

  async function salvarServidor(dados) {
    const atualizado = await apiFetch(`/api/servidores/${servidorAtivoId}`, sessao.token, { method: 'PATCH', body: JSON.stringify(dados) });
    setServidores((atual) => atual.map((servidor) => servidor.id === servidorAtivoId ? { ...servidor, ...atualizado } : servidor));
  }

  async function criarCargo(dados) {
    const novoCargo = await apiFetch(`/api/servidores/${servidorAtivoId}/cargos`, sessao.token, { method: 'POST', body: JSON.stringify(dados) });
    setCargosServidor((atual) => [...atual, novoCargo]);
  }

  async function atribuirCargo(usuarioId, cargoId, remover = false) {
    const caminho = `/api/servidores/${servidorAtivoId}/membros/${usuarioId}/cargos/${cargoId}`;
    await apiFetch(caminho, sessao.token, { method: remover ? 'DELETE' : 'POST' });
    const membrosAtualizados = await apiFetch(`/api/servidores/${servidorAtivoId}/membros`, sessao.token);
    setMembrosServidor(membrosAtualizados);
  }

  async function criarCanal(tipo, nome) {
    if (!nome || !nome.trim()) return;
    const novo = await apiFetch(`/api/servidores/${servidorAtivoId}/canais`, sessao.token, {
      method: 'POST',
      body: JSON.stringify({ nome: nome.trim(), tipo }),
    });
    setCanais((atual) => [...atual, novo]);
  }

  async function apagarCanal(canalId) {
    await apiFetch(`/api/servidores/${servidorAtivoId}/canais/${canalId}`, sessao.token, { method: 'DELETE' });
    setCanais((atual) => atual.filter((c) => c.id !== canalId));
    if (canalAtivo?.id === canalId) setCanalAtivo(null);
    if (canalDeVoz?.id === canalId) desconectarVoz();
  }

  function expulsarDaCall(canalId, usuarioId) {
    socket?.emit('expulsar-da-call', { canalId, usuarioId });
  }

  async function banirMembro(usuarioId) {
    await apiFetch(`/api/servidores/${servidorAtivoId}/membros/${usuarioId}/banir`, sessao.token, { method: 'POST' });
    setMembrosServidor((atual) => atual.filter((m) => m.id !== usuarioId));
  }

  async function expulsarMembro(usuarioId) {
    await apiFetch(`/api/servidores/${servidorAtivoId}/membros/${usuarioId}`, sessao.token, { method: 'DELETE' });
    setMembrosServidor((atual) => atual.filter((m) => m.id !== usuarioId));
  }

  function selecionarCanal(canal) {
    if (canal.tipo === 'voz' && (directCall.call || directCall.pending)) {
      directCall.reportError('Encerre sua chamada privada antes de entrar em um canal de voz.');
      return;
    }
    fecharVisualizacaoTransmissao();
    setMobileNavigationOpen(false);
    setCanalAtivo(canal);
    if (canal.tipo === 'voz') setCanalDeVoz({ ...canal, servidorId: servidorAtivoId, servidorNome: servidores.find((item) => item.id === servidorAtivoId)?.nome });
  }

  function fecharVisualizacaoTransmissao() {
    voiceChannelRef.current?.fecharTransmissao();
    setVozEstado((atual) => ({ ...atual, telaSelecionadaId: null }));
  }

  function desconectarVoz() {
    directCall.end();
    fecharVisualizacaoTransmissao();
    if (pickerContexto === 'call') setPickerTelaAberto(false);
    setCanalDeVoz(null);
    setVozEstado((atual) => ({ ...atual, telasAtivas: [], compartilhandoTela: false }));
  }

  function abrirChamada() {
    if (!canalDeVoz) return;
    if (activeRoom) fecharSala();
    if (canalDeVoz.direta) {
      setDmAtiva(canalDeVoz.amigo);
      setMobileNavigationOpen(false);
      setView('chamada-direta');
      return;
    }
    if (servidorAtivoId !== canalDeVoz.servidorId) {
      canalRetornoRef.current = canalDeVoz;
      setServidorAtivoId(canalDeVoz.servidorId);
    }
    setCanalAtivo(canalDeVoz);
    setMobileNavigationOpen(false);
    setView('servidor');
  }

  function abrirSeletorDaChamada() {
    if (!canalDeVoz) return;
    abrirChamada();
    setPickerContexto('call');
    setPickerTelaAberto(true);
  }

  function abrirSeletorDaSala() {
    setPickerContexto('room');
    setPickerTelaAberto(true);
  }

  const vozAcoes = {
    onAlternarMic: () => voiceChannelRef.current?.alternarMudo(),
    onAlternarAudio: () => voiceChannelRef.current?.alternarAudio(),
    onIniciarTela: abrirSeletorDaChamada,
    onTrocarFonte: abrirSeletorDaChamada,
    onAbrirChamada: abrirChamada,
    onPararTela: () => voiceChannelRef.current?.pararCompartilhamento(),
    onDesconectar: desconectarVoz,
  };

  function handleCompartilharTela(config) {
    if (pickerContexto === 'room' && activeRoom) {
      controladorCapturaRef.current?.abort();
      const controller = new AbortController();
      controladorCapturaRef.current = controller;
      const pedido = ++pedidoCapturaRef.current;
      setCaptureError('');
      const iniciar = async () => {
        try {
          const { stream: capturadoNoSeletor, ...configuracao } = config;
          const stream = capturadoNoSeletor || await requestScreenCapture(configuracao, undefined, { signal: controller.signal });
          if (pedido !== pedidoCapturaRef.current) {
            await stopScreenCapture(stream);
            return;
          }
          const warning = getScreenCaptureWarning(stream);
          if (warning) setCaptureError(warning);
          setScreenQuality(configuracao);
          const anterior = screenStreamRef.current;
          screenStreamRef.current = stream;
          if (anterior && anterior !== stream) stopScreenCapture(anterior).catch(() => {});
          setScreenStream(stream);
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack) videoTrack.addEventListener('ended', () => {
            setScreenStream((atual) => {
              if (atual !== stream) return atual;
              screenStreamRef.current = null;
              stopScreenCapture(stream).catch(() => {});
              return null;
            });
          }, { once: true });
          setPickerTelaAberto(false);
        } catch (error) {
          if (pedido !== pedidoCapturaRef.current) return;
          setCaptureError(error?.name === 'NotAllowedError' || error?.name === 'AbortError'
            ? 'A captura foi cancelada.'
            : 'Não foi possível iniciar a captura de tela. Confira as permissões do sistema.');
        }
      };
      iniciar();
      return;
    }
    if (!canalDeVoz || !voiceChannelRef.current) {
      if (config?.stream) stopScreenCapture(config.stream).catch(() => {});
      setPickerTelaAberto(false);
      return;
    }
    voiceChannelRef.current.iniciarCompartilhamento(config);
    setPickerTelaAberto(false);
  }

  function alterarEnderecoDaSala(roomId = null) {
    const url = new URL(window.location.href);
    url.search = '';
    if (roomId) url.searchParams.set('room', roomId);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function abrirSala({ roomId, accessCode = '' }) {
    setView('salas');
    if (!roomId) {
      const codigo = typeof accessCode === 'string' ? accessCode.trim().toUpperCase() : '';
      if (!codigo) return { ok: false, error: 'Informe o código de acesso.' };
      const resposta = await emitirSolicitacaoSala(socket, 'salas:entrar', { accessCode: codigo });
      if (!resposta?.ok) return resposta || { ok: false, error: 'Não foi possível entrar na sala.' };

      const roomIdResolvido = resposta.room?.id;
      if (!roomIdResolvido) {
        return { ok: false, error: 'O servidor não identificou a sala deste código.' };
      }
      setActiveRoom({
        ...resposta.room,
        roomId: roomIdResolvido,
        role: 'viewer',
        accessCode: codigo,
        joinedInitially: true,
        presenterSocketId: resposta.presenterSocketId ?? resposta.room.presenterSocketId ?? null,
        presenterName: resposta.presenterName ?? resposta.room.presenterName ?? null,
        youtubeSource: resposta.youtubeSource || null,
        youtubePlayback: resposta.youtubePlayback || null,
      });
      alterarEnderecoDaSala(roomIdResolvido);
      return { ok: true };
    }

    setActiveRoom({ roomId, role: 'viewer', accessCode, joinedInitially: false });
    alterarEnderecoDaSala(roomId);
    return { ok: true };
  }

  async function criarSala(dados) {
    if (!socket || !sessao) {
      setGuestLoginOpen(true);
      return { ok: false, error: 'Entre na sua conta para criar uma sala.' };
    }
    const resposta = await emitirSolicitacaoSala(socket, 'salas:criar', dados);
    if (!resposta?.ok) return resposta;
    setView('salas');
    setActiveRoom({
      ...resposta.room,
      roomId: resposta.room.id,
      role: 'host',
      joinedInitially: true,
      accessCode: resposta.accessCode || '',
      youtubeSource: resposta.youtubeSource || null,
      youtubePlayback: resposta.youtubePlayback || null,
    });
    setScreenStream(null);
    setScreenQuality(null);
    setCaptureError('');
    alterarEnderecoDaSala(resposta.room.id);
    return resposta;
  }

  async function pararCompartilhamentoDaSala() {
    cancelarPedidoCaptura();
    const atual = screenStreamRef.current;
    screenStreamRef.current = null;
    setScreenStream(null);
    if (atual) await stopScreenCapture(atual);
  }

  function fecharSala() {
    cancelarPedidoCaptura();
    if (screenStreamRef.current) stopScreenCapture(screenStreamRef.current).catch(() => {});
    screenStreamRef.current = null;
    setScreenStream(null);
    setScreenQuality(null);
    setCaptureError('');
    setActiveRoom(null);
    setPickerTelaAberto(false);
    alterarEnderecoDaSala(null);
  }

  function fecharSeletorTela() {
    cancelarPedidoCaptura();
    setPickerTelaAberto(false);
  }

  function selecionarServidor(id) {
    if (activeRoom) fecharSala();
    fecharVisualizacaoTransmissao();
    setMobileNavigationOpen(false);
    setServidorAtivoId(id);
    setView('servidor');
  }

  function abrirAmigos() {
    if (activeRoom) fecharSala();
    fecharVisualizacaoTransmissao();
    setMobileNavigationOpen(false);
    setView('amigos');
  }

  function abrirDM(amigo) {
    if (!sessao) { setGuestLoginOpen(true); return; }
    if (activeRoom) fecharSala();
    fecharVisualizacaoTransmissao();
    setMobileNavigationOpen(false);
    setDmAtiva(amigo);
    setView('dm');
  }

  function ligarParaAmigo(amigo) {
    if (!sessao) { setGuestLoginOpen(true); return; }
    if (canalDeVoz?.direta && String(canalDeVoz.amigo.id) === String(amigo.id)) { abrirChamada(); return; }
    abrirDM(amigo);
    void directCall.start(amigo);
  }

  const servidorAtivo = servidores.find((s) => s.id === servidorAtivoId);
  const aguardandoCanais = canaisCarregando || (servidorAtivo && canaisServidorId !== servidorAtivoId);
  const usuarioLogado = sessao ? {
    id: sessao.usuario.id,
    nome: sessao.usuario.nome,
    status: sessao.usuario.status,
    avatarCor: sessao.usuario.avatar_cor,
    avatarUrl: sessao.usuario.avatar_url,
    banner_url: sessao.usuario.banner_url,
    online: true,
  } : null;

  useEffect(() => {
    const title = view === 'servidor' ? servidorAtivo?.nome || 'Servidores'
      : view === 'dm' || view === 'chamada-direta' ? dmAtiva?.nome || 'Mensagens diretas'
        : view === 'amigos' ? 'Amigos' : 'Salas de tela';
    window.dispatchEvent(new CustomEvent('astralis:navigation', { detail: title }));
  }, [view, servidorAtivo?.nome, dmAtiva?.nome]);

  function abrirSalas() {
    fecharVisualizacaoTransmissao();
    setView('salas');
    setMobileNavigationOpen(false);
  }
  function abrirCriacaoServidor() {
    if (!sessao) { setGuestLoginOpen(true); return; }
    setModalAberto(true);
  }
  function abrirMeuPerfil() {
    if (!sessao) { setGuestLoginOpen(true); return; }
    setPerfilAberto(true);
  }

  // Junta as permissões de todos os cargos que o usuário logado tem
  // nesse servidor (o dono não precisa disso — sempre pode tudo).
  const meuMembro = membrosServidor.find((m) => m.id === sessao?.usuario.id);
  const minhasPermissoes = {};
  meuMembro?.cargos?.forEach((c) => {
    const cargoCompleto = cargosServidor.find((cc) => cc.id === c.id);
    if (cargoCompleto?.permissoes) {
      Object.entries(cargoCompleto.permissoes).forEach(([chave, valor]) => {
        if (valor) minhasPermissoes[chave] = true;
      });
    }
  });

  return (
    <div className="astralis-workspace" data-mobile-panel={mobileNavigationOpen ? 'navigation' : undefined}>
      <div className="mobile-nav"><button type="button" aria-label="Abrir navegação" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen((open) => !open)}><WorkspaceIcon name="menu"/></button><strong>{view === 'servidor' ? servidorAtivo?.nome || 'Servidores' : view === 'dm' || view === 'chamada-direta' ? dmAtiva?.nome : view === 'amigos' ? 'Amigos' : 'Salas de tela'}</strong><button type="button" aria-label="Configurações de usuário" onClick={() => setSettingsAberto(true)}><WorkspaceIcon name="settings"/></button></div>
      <div className={`app${vozEstado.telaSelecionadaId ? ' app--transmissao-aberta' : ''}`}>
      {mobileNavigationOpen && <button type="button" className="workspace-mobile-backdrop" aria-label="Fechar navegação" onClick={() => setMobileNavigationOpen(false)}/>}
      <ServerSidebar
        servidores={servidores}
        servidorAtivoId={servidorAtivoId}
        viewAtiva={view === 'dm' || view === 'chamada-direta' ? 'amigos' : view}
        onSelecionar={selecionarServidor}
        onAbrirAmigos={abrirAmigos}
        onAbrirSalas={view === 'salas' ? abrirSalas : undefined}
        onAbrirModal={abrirCriacaoServidor}
      />

      {(view !== 'servidor' || !servidorAtivo) && <HomeSidebar
        view={view} amigos={amigos} servidores={servidores} canais={canais}
        dmAtiva={dmAtiva} usuario={usuarioLogado} onAmigos={abrirAmigos} onSalas={abrirSalas}
        onDM={abrirDM} onServidor={selecionarServidor} onCanal={(channel) => { if (activeRoom) fecharSala(); setView('servidor'); selecionarCanal(channel); setMobileNavigationOpen(false); }}
        onPerfil={abrirMeuPerfil} onSettings={() => setSettingsAberto(true)}
        voice={vozEstado} voiceChannel={canalDeVoz} voiceActions={canalDeVoz ? vozAcoes : null} connected={status === 'conectado ao servidor'}
      />}

      {view === 'salas' && <section className="workspace-rooms" aria-label="Salas de tela">
        {activeRoom ? <StreamRoom
          socket={socket} roomId={activeRoom.roomId} role={activeRoom.role}
          room={activeRoom} accessCode={activeRoom.accessCode} joinedInitially={activeRoom.joinedInitially}
          localStream={screenStream} quality={screenQuality || undefined}
          onRequestShare={abrirSeletorDaSala} onStopShare={pararCompartilhamentoDaSala}
          onOpenSettings={abrirSeletorDaSala} onExit={fecharSala}
        /> : <RoomLobby socket={socket} usuario={usuarioLogado}
          onCriar={criarSala} onEntrar={abrirSala} onAbrirPerfil={abrirMeuPerfil}
          onEntrarNaConta={!sessao ? () => setGuestLoginOpen(true) : undefined}
        />}
        {captureError && <p className="rooms-toast" role="alert">{captureError}</p>}
      </section>}

      {view === 'servidor' && servidorAtivo && sessao && (
          <ChannelSidebar
            servidorNome={servidorAtivo.nome}
            codigoConvite={servidorAtivo.codigo_convite}
            souDono={servidorAtivo.papel === 'dono'}
            onExcluirServidor={() => excluirServidor(servidorAtivo.id)}
            onSairDoServidor={() => sairDoServidor(servidorAtivo.id)}
            minhasPermissoes={minhasPermissoes}
            canais={canaisServidorId === servidorAtivoId ? canais : []}
            canalAtivoId={canalAtivo?.id}
            onSelecionar={selecionarCanal}
            usuario={usuarioLogado}
            onSair={sair}
            onAbrirPerfil={() => setPerfilAberto(true)}
            onAbrirConfiguracao={() => setSettingsAberto(true)}
            canalDeVoz={canalDeVoz}
            presencaVoz={presencaVoz}
            vozEstado={vozEstado}
            vozAcoes={vozAcoes}
            nomeUsuarioNaVoz={sessao.usuario.nome}
            onAbrirServidorConfiguracao={() => setServidorConfiguracaoAberto(true)}
            onCriarCanal={(tipo) => setCriacaoCanal({ tipo, servidorId: servidorAtivoId })}
            onApagarCanal={apagarCanal}
            onExpulsarDaCall={expulsarDaCall}
            onAssistirTransmissao={(socketId) => { abrirChamada(); voiceChannelRef.current?.alternarTransmissao(socketId); }}
          />
      )}
      {view === 'servidor' && !servidoresCarregando && !erroServidores && !aguardandoCanais && !erroCanais && servidorAtivo && canalAtivo?.tipo === 'texto' && sessao && (
        <>
          <ChatArea
            canal={canalAtivo}
            statusConexao={status}
            socket={socket}
            token={sessao.token}
            nomeUsuario={sessao.usuario.nome}
            meuUsuarioId={sessao.usuario.id}
            podeApagarMensagens={servidorAtivo.papel === 'dono' || !!minhasPermissoes.gerenciar_mensagens}
            membrosVisiveis={membrosVisiveis} onToggleMembros={() => setMembrosVisiveis((visible) => !visible)}
          />
          {membrosVisiveis && <MemberSidebar membros={membrosServidor} />}
        </>
      )}

      {view === 'servidor' && !aguardandoCanais && !erroCanais && canalAtivo?.tipo === 'voz' && canalDeVoz?.id !== canalAtivo.id && sessao && (
        <VoiceChannelEntry canal={canalAtivo} participantes={presencaVoz[canalAtivo.id] || []} onEntrar={() => selecionarCanal(canalAtivo)} />
      )}

      {view === 'servidor' && servidoresCarregando && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card" role="status" aria-live="polite">
              <h1>Carregando seus servidores…</h1>
              <p>A primeira conexão pode demorar alguns segundos enquanto o servidor desperta.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && erroServidores && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card" role="alert">
              <h1>Não foi possível carregar seus servidores</h1>
              <p>{erroServidores}</p>
              <button type="button" onClick={() => setTentativaServidores((valor) => valor + 1)}>
                Tentar novamente
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidores.length === 0 && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card">
              <div className="server-empty-card__mark" aria-hidden="true">
                <img src="./astralis-mark.svg" alt="" />
              </div>
              <h1>Nenhum servidor</h1>
              <p>Crie um servidor ou entre com um convite.</p>
              <button type="button" onClick={() => setModalAberto(true)}>
                Criar ou entrar
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && aguardandoCanais && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card" role="status" aria-live="polite">
              <h1>Carregando canais…</h1>
              <p>A primeira conexão pode demorar alguns segundos enquanto o servidor desperta.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && !aguardandoCanais && erroCanais && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card" role="alert">
              <h1>Não foi possível carregar os canais</h1>
              <p>{erroCanais}</p>
              <button type="button" onClick={() => setTentativaCanais((valor) => valor + 1)}>
                Tentar novamente
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && !aguardandoCanais && !erroCanais && canais.length === 0 && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card">
              <h1>Nenhum canal</h1>
              <p>Este servidor ainda não tem canais.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'amigos' && <FriendsScreen amigos={amigos} pedidos={friendships.pedidos} meuUsuario={sessao?.usuario}
        carregando={friendships.carregando} erro={friendships.erro} onTentarNovamente={friendships.refresh}
        onAbrirDM={abrirDM} onAdicionarAmigo={friendships.adicionar} onAceitarPedido={friendships.aceitar}
        onRecusarPedido={friendships.recusar} onRemoverAmigo={friendships.remover} onLigar={ligarParaAmigo}
        onEntrarNaConta={!sessao ? () => setGuestLoginOpen(true) : undefined} />}

      {view === 'dm' && dmAtiva && sessao && (
        <DirectMessageScreen amigo={dmAtual} socket={socket} token={sessao.token} meuId={sessao.usuario.id} meuUsuario={sessao.usuario}
          onLigar={() => ligarParaAmigo(dmAtual)} ligacaoPendente={directCall.pending || Boolean(directCall.call)}
          chamadaAtiva={Boolean(canalDeVoz?.direta && String(canalDeVoz.amigo.id) === String(dmAtiva.id))}
          onAbrirChamada={abrirChamada} />
      )}

      {canalDeVoz && sessao && (
        <VoiceChannel
          key={canalDeVoz.id}
          ref={voiceChannelRef}
          canal={canalDeVoz}
          socket={socket}
          nomeUsuario={sessao.usuario.nome}
          usuario={usuarioLogado}
          visible={canalDeVoz.direta ? view === 'chamada-direta' : view === 'servidor' && canalAtivo?.id === canalDeVoz.id}
          onAbrirConversa={canalDeVoz.direta ? () => abrirDM(canalDeVoz.amigo) : undefined}
          onCompartilharTela={abrirSeletorDaChamada}
          onAbrirConfiguracoes={() => { setSettingsInitialSection('voice'); setSettingsAberto(true); }}
          onDesconectar={desconectarVoz}
          onEstadoChange={setVozEstado}
        />
      )}

      {directCall.call?.status === 'ringing' && <DirectCallNotice
        call={directCall.call} incoming={directCall.incoming} pending={directCall.pending}
        error={directCall.error} onAccept={directCall.accept} onEnd={directCall.end} />}
      {directCall.error && directCall.call?.status !== 'ringing' && <div className="direct-call-feedback" role="alert">
        <span>{directCall.error}</span><button type="button" onClick={directCall.clearError} aria-label="Fechar aviso de chamada">×</button>
      </div>}

      {modalAberto && sessao && (
        <AddServerModal
          onFechar={() => setModalAberto(false)}
          onCriar={criarServidor}
          onEntrar={entrarComCodigo}
        />
      )}
      {perfilAberto && sessao && (
        <ProfileModal
          usuario={sessao.usuario}
          onFechar={() => setPerfilAberto(false)}
          onSalvar={salvarPerfil}
        />
      )}

      {settingsAberto && (
        <SettingsModal
          initialSection={settingsInitialSection}
          usuario={sessao?.usuario}
          onAbrirPerfil={() => { setSettingsAberto(false); setSettingsInitialSection('account'); abrirMeuPerfil(); }}
          onSair={sessao ? sair : undefined}
          onFechar={() => { setSettingsAberto(false); setSettingsInitialSection('account'); }}
          onSalvarConfiguracao={(config) => {
            // Configuração já foi salva em localStorage no componente
            voiceChannelRef.current?.aplicarConfiguracao(config);
          }}
        />
      )}

      {criacaoCanal && criacaoCanal.servidorId === servidorAtivoId && (
        <CreateChannelModal
          tipo={criacaoCanal.tipo}
          onCriar={(nome) => criarCanal(criacaoCanal.tipo, nome)}
          onFechar={() => setCriacaoCanal(null)}
        />
      )}

      {servidorConfiguracaoAberto && servidorAtivo && (
        <ServerSettingsModal
          servidor={servidorAtivo}
          cargos={cargosServidor}
          onFechar={() => setServidorConfiguracaoAberto(false)}
          onSalvar={salvarServidor}
          onCriarCargo={criarCargo}
          membros={membrosServidor}
          onAtribuirCargo={atribuirCargo}
          onBanir={servidorAtivo.papel === 'dono' || minhasPermissoes.banir_membros ? banirMembro : undefined}
          onExpulsarMembro={servidorAtivo.papel === 'dono' || minhasPermissoes.gerenciar_membros ? expulsarMembro : undefined}
        />
      )}

      {pickerTelaAberto && (
        <ScreenShareSourcePicker
          contexto={pickerContexto}
          canalNome={pickerContexto === 'call' ? canalDeVoz?.nome : activeRoom?.name}
          onFechar={fecharSeletorTela}
          onSelecionar={handleCompartilharTela}
        />
      )}
      {!sessao && guestLoginOpen && <div className="workspace-login" role="dialog" aria-modal="true" aria-label="Entrar no Astralis">
        <button type="button" className="workspace-login__close" onClick={() => setGuestLoginOpen(false)} aria-label="Fechar login">×</button>
        <LoginScreen onAutenticado={autenticar}/>
      </div>}
      </div>
    </div>
  );
}
