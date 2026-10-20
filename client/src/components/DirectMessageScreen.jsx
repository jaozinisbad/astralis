import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { apiFetch } from '../api.js';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import { SocialIcon, SocialMessageList, SocialComposer, mergeSocialMessages, sameSocialId, useSocialNotifications } from './SocialMessageParts.jsx';
import './SocialWorkspace.css';
import { CallIcon } from './VoiceCallStage.jsx';

export default function DirectMessageScreen({ amigo, socket, token, meuId, meuUsuario, onLigar, ligacaoPendente, chamadaAtiva, onAbrirChamada }) {
  const [mensagens, setMensagens] = useState([]);
  const [texto, setTexto] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erroHistorico, setErroHistorico] = useState('');
  const [tentativa, setTentativa] = useState(0);
  const [erroEnvio, setErroEnvio] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [socketConectado, setSocketConectado] = useState(socket?.connected !== false);
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [busca, setBusca] = useState('');
  const [prefs] = useInterfacePreferences();
  const notificar = useSocialNotifications(prefs);
  const notificacaoRef = useRef(notificar);
  notificacaoRef.current = notificar;
  const pendente = useRef(null);
  const historicoPendente = useRef(null);
  const fimDaLista = useRef(null);
  const conectado = Boolean(socket) && socketConectado;
  const nomeAmigo = prefs.streamerMode ? 'Conversa privada' : amigo.nome;

  useEffect(() => {
    setMensagens([]); setTexto(''); setBusca(''); setBuscaAberta(false); setErroEnvio(''); setEnviando(false);
    return () => { clearTimeout(pendente.current?.timer); pendente.current = null; };
  }, [amigo.id]);
  useEffect(() => {
    let ativo = true;
    const controller = new AbortController();
    const request = { live: [] };
    historicoPendente.current = request;
    setCarregando(true); setErroHistorico('');
    apiFetch(`/api/mensagens-diretas/${amigo.id}`, token, { signal: controller.signal })
      .then((dados) => {
        if (!Array.isArray(dados)) throw new Error('O servidor retornou um histórico inválido.');
        if (ativo) setMensagens(mergeSocialMessages(dados, request.live));
      })
      .catch((error) => { if (ativo) setErroHistorico(error.message || 'Não foi possível carregar a conversa.'); })
      .finally(() => { if (ativo) setCarregando(false); if (historicoPendente.current === request) historicoPendente.current = null; });
    return () => { ativo = false; controller.abort(); if (historicoPendente.current === request) historicoPendente.current = null; };
  }, [amigo.id, token, tentativa]);
  useEffect(() => {
    if (!socket) return undefined;
    setSocketConectado(socket.connected !== false);
    function aoConectar() { setSocketConectado(true); setTentativa((atual) => atual + 1); }
    function aoReceber({ comUsuarioId, deUsuarioId, mensagem }) {
      const pertence = (sameSocialId(deUsuarioId, amigo.id) && sameSocialId(comUsuarioId, meuId)) || (sameSocialId(deUsuarioId, meuId) && sameSocialId(comUsuarioId, amigo.id));
      if (!pertence) return;
      historicoPendente.current?.live.push(mensagem);
      setMensagens((atual) => mergeSocialMessages(atual, [mensagem]));
      if (!sameSocialId(mensagem.remetente_id, meuId)) notificacaoRef.current(amigo.nome, mensagem.conteudo);
      const atual = pendente.current;
      if (atual && sameSocialId(mensagem.remetente_id, meuId) && mensagem.conteudo === atual.texto) {
        clearTimeout(atual.timer); pendente.current = null; setTexto(''); setEnviando(false); setErroEnvio('');
      }
    }
    function aoDesconectar() {
      setSocketConectado(false);
      if (!pendente.current) return;
      clearTimeout(pendente.current.timer); pendente.current = null; setEnviando(false);
      setErroEnvio('A conexão foi interrompida antes da confirmação. Confira a conversa antes de reenviar; seu rascunho foi preservado.');
    }
    socket.on('nova-dm', aoReceber); socket.on('disconnect', aoDesconectar); socket.on('connect', aoConectar);
    return () => { socket.off('nova-dm', aoReceber); socket.off('disconnect', aoDesconectar); socket.off('connect', aoConectar); };
  }, [socket, amigo.id, amigo.nome, meuId]);
  useEffect(() => { fimDaLista.current?.scrollIntoView?.({ behavior: prefs.reducedMotion ? 'auto' : 'smooth' }); }, [mensagens, prefs.reducedMotion]);
  function enviar(event) {
    event.preventDefault();
    if (pendente.current || enviando || !texto.trim()) return;
    if (!conectado) { setErroEnvio('Conecte-se ao servidor para enviar. Seu rascunho foi preservado.'); return; }
    const pending = { texto: texto.trim() };
    pending.timer = setTimeout(() => {
      if (pendente.current !== pending) return;
      pendente.current = null; setEnviando(false);
      setErroEnvio('O servidor não confirmou o envio. Confira a conversa antes de reenviar; seu rascunho foi preservado.');
    }, 15_000);
    pendente.current = pending; setEnviando(true); setErroEnvio('');
    try { socket.emit('enviar-dm', { paraUsuarioId: amigo.id, conteudo: pending.texto }); }
    catch { clearTimeout(pending.timer); pendente.current = null; setEnviando(false); setErroEnvio('Não foi possível enviar. Seu rascunho foi preservado.'); }
  }
  const filtradas = busca.trim() ? mensagens.filter((mensagem) => mensagem.conteudo?.toLocaleLowerCase('pt-BR').includes(busca.trim().toLocaleLowerCase('pt-BR'))) : mensagens;
  return <section className="content social-workspace social-chat social-dm">
    <header className="social-header">
      <span className="social-dm__avatar"><Avatar nome={nomeAmigo} avatarUrl={prefs.streamerMode ? null : amigo.avatar_url} avatarCor={amigo.avatar_cor || 'var(--as-accent)'} tamanho="sm" /></span>
      <h1>{nomeAmigo}</h1><span className={`social-dm__presence ${amigo.online ? 'social-dm__presence--online' : ''}`} aria-label={amigo.online ? 'Online' : 'Offline'} />
      <div className="social-header__actions">
        {onLigar && <button type="button" onClick={chamadaAtiva ? onAbrirChamada : onLigar}
          disabled={!chamadaAtiva && (!conectado || !amigo.online || ligacaoPendente)}
          title={chamadaAtiva ? 'Voltar à chamada' : !amigo.online ? 'Amigo offline' : 'Iniciar chamada de voz'}
          aria-label={chamadaAtiva ? 'Voltar à chamada' : `Ligar para ${nomeAmigo}`}><CallIcon name="phone" size={22}/></button>}
        <button type="button" onClick={() => { setBuscaAberta((atual) => !atual); setBusca(''); }} aria-expanded={buscaAberta} title="Buscar nesta conversa" aria-label="Buscar nesta conversa"><SocialIcon name="search" /></button>
      </div>
    </header>
    {chamadaAtiva && <div className="social-dm__call-banner"><span>Sua chamada continua em andamento.</span><button type="button" onClick={onAbrirChamada}>Voltar à chamada</button></div>}
    {buscaAberta && <label className="social-search social-chat__search"><SocialIcon name="search" size={18} /><input type="search" aria-label="Buscar nas mensagens carregadas" placeholder="Buscar nas mensagens carregadas" value={busca} onChange={(event) => setBusca(event.target.value)} autoFocus /><span>{filtradas.length} resultados</span></label>}
    <div className="social-chat__history">
      {carregando && <p className="social-feedback" role="status">Carregando conversa…</p>}
      {erroHistorico && <div className="social-feedback social-feedback--error" role="alert"><span>{erroHistorico}</span><button type="button" onClick={() => setTentativa((valor) => valor + 1)}>Tentar novamente</button></div>}
      {!carregando && <SocialMessageList messages={filtradas} preferences={prefs} endRef={fimDaLista} resolveAuthor={(message) => sameSocialId(message.remetente_id, meuId) ? { name: meuUsuario?.nome || 'Você', avatarUrl: meuUsuario?.avatar_url, avatarColor: meuUsuario?.avatar_cor } : { name: amigo.nome, avatarUrl: amigo.avatar_url, avatarColor: amigo.avatar_cor }} emptyTitle={busca ? 'Nenhuma mensagem encontrada' : nomeAmigo} emptyDescription={busca ? 'Tente outro termo nas mensagens carregadas.' : `Este é o começo da sua conversa com ${nomeAmigo}.`} />}
    </div>
    <SocialComposer value={texto} onChange={setTexto} onSubmit={enviar} placeholder={`Conversar com ${nomeAmigo}`} preferences={prefs} sending={enviando} error={erroEnvio} connected={conectado} />
  </section>;
}
