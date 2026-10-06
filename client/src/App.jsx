import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import packageJson from '../package.json';
import ServerSidebar from './components/ServerSidebar.jsx';
import ChannelSidebar from './components/ChannelSidebar.jsx';
import ChatArea from './components/ChatArea.jsx';
import VoiceChannel from './components/VoiceChannel.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import AddServerModal from './components/AddServerModal.jsx';
import ProfileModal from './components/ProfileModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import ScreenShareSourcePicker from './components/ScreenShareSourcePicker.jsx';
import FriendsScreen from './components/FriendsScreen.jsx';
import DirectMessageScreen from './components/DirectMessageScreen.jsx';
import ServerSettingsModal from './components/ServerSettingsModal.jsx';
import MemberSidebar from './components/MemberSidebar.jsx';
import { SERVER_URL, apiFetch } from './api.js';

export default function App() {
  const [sessao, setSessao] = useState(() => {
    const salvo = localStorage.getItem('sessao');
    return salvo ? JSON.parse(salvo) : null;
  });
  const [status, setStatus] = useState('conectando...');
  const [socket, setSocket] = useState(null);

  const [servidores, setServidores] = useState([]);
  const [servidoresCarregando, setServidoresCarregando] = useState(false);
  const [erroServidores, setErroServidores] = useState('');
  const [tentativaServidores, setTentativaServidores] = useState(0);
  const [servidorAtivoId, setServidorAtivoId] = useState(null);
  const [canais, setCanais] = useState([]);
  const [canaisCarregando, setCanaisCarregando] = useState(false);
  const [erroCanais, setErroCanais] = useState('');
  const [tentativaCanais, setTentativaCanais] = useState(0);
  const [membrosServidor, setMembrosServidor] = useState([]);
  const [cargosServidor, setCargosServidor] = useState([]);
  const [canalAtivo, setCanalAtivo] = useState(null);
  const [canalDeVoz, setCanalDeVoz] = useState(null);
  const [vozEstado, setVozEstado] = useState({
    participantes: [],
    micMudo: false,
    audioMudo: false,
    compartilhandoTela: false,
    erro: '',
    erroCompartilhamento: '',
    conectando: true,
  });
  const voiceChannelRef = useRef(null);
  const [modalAberto, setModalAberto] = useState(false);
  const [perfilAberto, setPerfilAberto] = useState(false);
  const [settingsAberto, setSettingsAberto] = useState(false);
  const [servidorConfiguracaoAberto, setServidorConfiguracaoAberto] = useState(false);
  const [pickerTelaAberto, setPickerTelaAberto] = useState(false);
  const [atualizacaoPronta, setAtualizacaoPronta] = useState(false);

  // view: 'servidor' | 'amigos' | 'dm'
  const [view, setView] = useState('servidor');
  const [amigos, setAmigos] = useState([]);
  const [dmAtiva, setDmAtiva] = useState(null); // amigo com quem está conversando

  // Quem está em cada canal de voz, de TODOS os servidores já vistos —
  // canalId -> [{socketId, nome, avatarCor, avatarUrl}]. Isso alimenta a
  // pré-visualização de participantes mesmo sem você estar na call.
  const [presencaVoz, setPresencaVoz] = useState({});

  // Escuta o aviso do processo main quando uma atualização já foi
  // baixada e está pronta pra instalar (só existe rodando empacotado).
  useEffect(() => {
    if (!window.electronAPI?.onAtualizacaoPronta) return;
    window.electronAPI.onAtualizacaoPronta(() => setAtualizacaoPronta(true));
  }, []);

  useEffect(() => {
    function aoInvalidarSessao() {
      setSessao(null);
      setSocket((atual) => {
        atual?.disconnect();
        return null;
      });
    }
    window.addEventListener('sessao-invalida', aoInvalidarSessao);
    return () => window.removeEventListener('sessao-invalida', aoInvalidarSessao);
  }, []);

  // Conecta o socket assim que há sessão.
  useEffect(() => {
    if (!sessao) return;
    const s = io(SERVER_URL, {
      auth: { token: sessao.token },
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

  // Carrega a lista de amigos assim que loga.
  useEffect(() => {
    if (!sessao) return;
    apiFetch('/api/amigos', sessao.token)
      .then(setAmigos)
      .catch(() => {});
  }, [sessao]);

  // Atualiza a lista de amigos em tempo real quando alguém fica online/offline
  // (sem precisar recarregar tudo do zero a cada evento).
  useEffect(() => {
    if (!socket) return;
    function online({ usuarioId }) {
      setAmigos((atual) => atual.map((a) => (a.id === usuarioId ? { ...a, online: true } : a)));
    }
    function offline({ usuarioId }) {
      setAmigos((atual) => atual.map((a) => (a.id === usuarioId ? { ...a, online: false } : a)));
      setMembrosServidor((atual) => atual.map((m) => (m.id === usuarioId ? { ...m, online: false } : m)));
    }
    function membroOnline({ usuarioId }) {
      setMembrosServidor((atual) => atual.map((m) => (m.id === usuarioId ? { ...m, online: true } : m)));
    }
    socket.on('amigo-online', online);
    socket.on('amigo-offline', offline);
    socket.on('amigo-online', membroOnline);

    function aoAtualizarPresencaVoz({ canalId, participantes }) {
      setPresencaVoz((atual) => ({ ...atual, [canalId]: participantes }));
    }
    socket.on('presenca-voz-canal', aoAtualizarPresencaVoz);

    function aoSerExpulsoDaCall() {
      setCanalDeVoz(null);
    }
    socket.on('voce-foi-expulso-da-call', aoSerExpulsoDaCall);

    return () => {
      socket.off('amigo-online', online);
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
      return () => { ativo = false; };
    }

    setCanaisCarregando(true);
    setErroCanais('');
    setCanais([]);
    setCanalAtivo(null);
    apiFetch(`/api/servidores/${servidorAtivoId}/canais`, sessao.token)
      .then((lista) => {
        if (!ativo) return;
        setCanais(lista);
        setCanalAtivo(lista[0] || null);
      })
      .catch((erro) => {
        if (!ativo) return;
        setErroCanais(erro.message || 'Não foi possível carregar os canais.');
      })
      .finally(() => {
        if (ativo) setCanaisCarregando(false);
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
    setSessao(novaSessao);
  }

  function sair() {
    localStorage.removeItem('sessao');
    socket?.disconnect();
    setSessao(null);
    setServidores([]);
    setServidorAtivoId(null);
    setCanais([]);
    setCanalAtivo(null);
    setCanalDeVoz(null);
    setAmigos([]);
    setDmAtiva(null);
    setView('servidor');
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
    // A pessoa dona do servidor virou um novo amigo (compartilham servidor agora).
    apiFetch('/api/amigos', sessao.token).then(setAmigos).catch(() => {});
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

  async function criarCanal(tipo) {
    const nome = window.prompt(tipo === 'texto' ? 'Nome do canal de texto:' : 'Nome do canal de voz:');
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
    if (canalDeVoz?.id === canalId) setCanalDeVoz(null);
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
    setCanalAtivo(canal);
    if (canal.tipo === 'voz') setCanalDeVoz(canal);
  }

  function desconectarVoz() {
    setCanalDeVoz(null);
  }

  const vozAcoes = {
    onAlternarMic: () => voiceChannelRef.current?.alternarMudo(),
    onAlternarAudio: () => voiceChannelRef.current?.alternarAudio(),
    onIniciarTela: () => setPickerTelaAberto(true),
    onPararTela: () => voiceChannelRef.current?.pararCompartilhamento(),
    onDesconectar: desconectarVoz,
  };

  function handleCompartilharTela(config) {
    voiceChannelRef.current?.iniciarCompartilhamento(config);
    setPickerTelaAberto(false);
  }

  function selecionarServidor(id) {
    setServidorAtivoId(id);
    setView('servidor');
  }

  function abrirAmigos() {
    setView('amigos');
  }

  function abrirDM(amigo) {
    setDmAtiva(amigo);
    setView('dm');
  }

  if (!sessao) {
    return <LoginScreen onAutenticado={autenticar} />;
  }

  const servidorAtivo = servidores.find((s) => s.id === servidorAtivoId);
  const usuarioLogado = {
    nome: sessao.usuario.nome,
    status: sessao.usuario.status,
    avatarCor: sessao.usuario.avatar_cor,
    avatarUrl: sessao.usuario.avatar_url,
    banner_url: sessao.usuario.banner_url,
    online: true,
  };

  // Junta as permissões de todos os cargos que o usuário logado tem
  // nesse servidor (o dono não precisa disso — sempre pode tudo).
  const meuMembro = membrosServidor.find((m) => m.id === sessao.usuario.id);
  const minhasPermissoes = {};
  meuMembro?.cargos.forEach((c) => {
    const cargoCompleto = cargosServidor.find((cc) => cc.id === c.id);
    if (cargoCompleto?.permissoes) {
      Object.entries(cargoCompleto.permissoes).forEach(([chave, valor]) => {
        if (valor) minhasPermissoes[chave] = true;
      });
    }
  });

  return (
    <>
      <div className="app">
      {atualizacaoPronta && (
        <div className="atualizacao-banner">
          <span>Uma atualização foi baixada.</span>
          <button type="button" onClick={() => window.electronAPI.reiniciarParaAtualizar()}>
            Reiniciar agora
          </button>
        </div>
      )}
      <ServerSidebar
        servidores={servidores}
        servidorAtivoId={servidorAtivoId}
        viewAtiva={view === 'amigos' || view === 'dm' ? 'amigos' : 'servidor'}
        onSelecionar={selecionarServidor}
        onAbrirAmigos={abrirAmigos}
        onAbrirModal={() => setModalAberto(true)}
      />

      {view === 'servidor' && servidorAtivo && canalAtivo && (
        <>
          <ChannelSidebar
            servidorNome={servidorAtivo.nome}
            codigoConvite={servidorAtivo.codigo_convite}
            souDono={servidorAtivo.papel === 'dono'}
            onExcluirServidor={() => excluirServidor(servidorAtivo.id)}
            onSairDoServidor={() => sairDoServidor(servidorAtivo.id)}
            minhasPermissoes={minhasPermissoes}
            canais={canais}
            canalAtivoId={canalAtivo.id}
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
            onCriarCanal={criarCanal}
            onApagarCanal={apagarCanal}
            onExpulsarDaCall={expulsarDaCall}
          />
          <ChatArea
            canal={canalAtivo}
            statusConexao={status}
            socket={socket}
            token={sessao.token}
            nomeUsuario={sessao.usuario.nome}
            meuUsuarioId={sessao.usuario.id}
            podeApagarMensagens={servidorAtivo.papel === 'dono' || !!minhasPermissoes.gerenciar_mensagens}
          />
          <MemberSidebar membros={membrosServidor} />
        </>
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

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && canaisCarregando && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card" role="status" aria-live="polite">
              <h1>Carregando canais…</h1>
              <p>A primeira conexão pode demorar alguns segundos enquanto o servidor desperta.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && !canaisCarregando && erroCanais && (
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

      {view === 'servidor' && !servidoresCarregando && !erroServidores && servidorAtivo && !canaisCarregando && !erroCanais && canais.length === 0 && (
        <div className="content server-empty-screen">
          <div className="content__body server-empty-screen__body">
            <div className="server-empty-card">
              <h1>Nenhum canal</h1>
              <p>Este servidor ainda não tem canais.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'amigos' && <FriendsScreen amigos={amigos} onAbrirDM={abrirDM} />}

      {view === 'dm' && dmAtiva && (
        <DirectMessageScreen amigo={dmAtiva} socket={socket} token={sessao.token} meuId={sessao.usuario.id} />
      )}

      {canalDeVoz && (
        <VoiceChannel
          ref={voiceChannelRef}
          canal={canalDeVoz}
          socket={socket}
          nomeUsuario={sessao.usuario.nome}
          onDesconectar={desconectarVoz}
          onEstadoChange={setVozEstado}
        />
      )}

      {modalAberto && (
        <AddServerModal
          onFechar={() => setModalAberto(false)}
          onCriar={criarServidor}
          onEntrar={entrarComCodigo}
        />
      )}
      {perfilAberto && (
        <ProfileModal
          usuario={sessao.usuario}
          onFechar={() => setPerfilAberto(false)}
          onSalvar={salvarPerfil}
        />
      )}

      {settingsAberto && (
        <SettingsModal
          onFechar={() => setSettingsAberto(false)}
          onSalvarConfiguracao={(config) => {
            // Configuração já foi salva em localStorage no componente
            voiceChannelRef.current?.aplicarConfiguracao(config);
          }}
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
          onFechar={() => setPickerTelaAberto(false)}
          onSelecionar={handleCompartilharTela}
        />
      )}
      </div>
      <div className="versao-watermark">v{packageJson.version}</div>
    </>
  );
}
