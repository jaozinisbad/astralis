import React, { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api.js';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import { SocialIcon, SocialMessageList, SocialComposer, mergeSocialMessages, sameSocialId, useSocialNotifications } from './SocialMessageParts.jsx';
import './SocialWorkspace.css';

export default function ChatArea({ canal, statusConexao, socket, token, nomeUsuario, meuUsuarioId, podeApagarMensagens, onToggleMembros, membrosVisiveis = true }) {
  const [mensagens, setMensagens] = useState([]);
  const [texto, setTexto] = useState('');
  const [arquivo, setArquivo] = useState(null);
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
  const leitorRef = useRef(null);
  const fimDaLista = useRef(null);
  const inputArquivo = useRef(null);
  const canalRef = useRef(canal.id);
  canalRef.current = canal.id;
  const conectado = Boolean(socket) && socketConectado && statusConexao === 'conectado ao servidor';

  useEffect(() => {
    setMensagens([]); setTexto(''); setArquivo(null); setBusca(''); setBuscaAberta(false); setErroEnvio(''); setEnviando(false);
    return () => {
      clearTimeout(pendente.current?.timer); pendente.current = null;
      leitorRef.current?.abort(); leitorRef.current = null;
    };
  }, [canal.id]);

  useEffect(() => {
    if (canal.tipo !== 'texto') { setCarregando(false); return undefined; }
    let ativo = true;
    const controller = new AbortController();
    const request = { live: [], deleted: new Set() };
    historicoPendente.current = request;
    setCarregando(true); setErroHistorico('');
    socket?.emit('entrar-canal', canal.id);
    apiFetch(`/api/canais/${canal.id}/mensagens`, token, { signal: controller.signal })
      .then((dados) => {
        if (!Array.isArray(dados)) throw new Error('O servidor retornou um histórico inválido.');
        if (ativo) setMensagens(mergeSocialMessages(dados, request.live).filter((message) => !request.deleted.has(String(message.id))));
      })
      .catch((error) => { if (ativo) setErroHistorico(error.message || 'Não foi possível carregar as mensagens.'); })
      .finally(() => { if (ativo) setCarregando(false); if (historicoPendente.current === request) historicoPendente.current = null; });
    return () => { ativo = false; controller.abort(); if (historicoPendente.current === request) historicoPendente.current = null; socket?.emit('sair-canal', canal.id); };
  }, [canal.id, canal.tipo, socket, token, tentativa]);

  useEffect(() => {
    if (!socket) return undefined;
    setSocketConectado(socket.connected !== false);
    function aoConectar() {
      setSocketConectado(true);
      // Socket.IO rooms are lost on reconnect. Rejoin and fetch messages sent while away.
      setTentativa((atual) => atual + 1);
    }
    function aoReceber({ canalId, mensagem }) {
      if (!sameSocialId(canalId, canal.id)) return;
      historicoPendente.current?.live.push(mensagem);
      setMensagens((atual) => mergeSocialMessages(atual, [mensagem]));
      if (!sameSocialId(mensagem.usuario_id, meuUsuarioId)) notificacaoRef.current(`#${canal.nome} · ${mensagem.autor || 'Astralis'}`, mensagem.conteudo);
      const atual = pendente.current;
      if (atual && sameSocialId(mensagem.usuario_id, meuUsuarioId) && mensagem.conteudo === atual.texto && (mensagem.anexo_nome || '') === (atual.arquivo?.name || '')) {
        clearTimeout(atual.timer); pendente.current = null;
        setTexto(''); setArquivo(null); setEnviando(false); setErroEnvio('');
        if (inputArquivo.current) inputArquivo.current.value = '';
      }
    }
    function aoApagar({ canalId, mensagemId }) {
      if (sameSocialId(canalId, canal.id)) {
        historicoPendente.current?.deleted.add(String(mensagemId));
        setMensagens((atual) => atual.filter((mensagem) => !sameSocialId(mensagem.id, mensagemId)));
      }
    }
    function aoDesconectar() {
      setSocketConectado(false);
      if (!pendente.current) return;
      clearTimeout(pendente.current.timer); pendente.current = null; setEnviando(false);
      setErroEnvio('A conexão foi interrompida antes da confirmação. Confira a conversa antes de reenviar; seu rascunho foi preservado.');
    }
    socket.on('nova-mensagem', aoReceber); socket.on('mensagem-apagada', aoApagar); socket.on('disconnect', aoDesconectar); socket.on('connect', aoConectar);
    return () => { socket.off('nova-mensagem', aoReceber); socket.off('mensagem-apagada', aoApagar); socket.off('disconnect', aoDesconectar); socket.off('connect', aoConectar); };
  }, [socket, canal.id, canal.nome, meuUsuarioId]);

  useEffect(() => { fimDaLista.current?.scrollIntoView?.({ behavior: prefs.reducedMotion ? 'auto' : 'smooth' }); }, [mensagens, prefs.reducedMotion]);

  function enviar(event) {
    event.preventDefault();
    if (pendente.current || enviando || (!texto.trim() && !arquivo)) return;
    if (!conectado) { setErroEnvio('Conecte-se ao servidor para enviar. Seu rascunho foi preservado.'); return; }
    if (arquivo && arquivo.size > 5 * 1024 * 1024) { setErroEnvio('O arquivo precisa ter no máximo 5 MB.'); return; }
    setErroEnvio(''); setEnviando(true);
    const canalDoEnvio = canal.id;
    const conteudo = texto.trim();
    const arquivoDoEnvio = arquivo;
    const enviarComDados = (url) => {
      if (!sameSocialId(canalRef.current, canalDoEnvio)) return;
      const pending = { texto: conteudo, arquivo: arquivoDoEnvio };
      pending.timer = setTimeout(() => {
        if (pendente.current !== pending) return;
        pendente.current = null; setEnviando(false);
        setErroEnvio('O servidor não confirmou o envio. Confira a conversa antes de reenviar; seu rascunho foi preservado.');
      }, 15_000);
      pendente.current = pending;
      try {
        socket.emit('enviar-mensagem', { canalId: canalDoEnvio, conteudo, anexo: arquivoDoEnvio ? { nome: arquivoDoEnvio.name, tipo: arquivoDoEnvio.type || 'application/octet-stream', tamanho: arquivoDoEnvio.size, url } : null });
      } catch {
        clearTimeout(pending.timer); pendente.current = null; setEnviando(false); setErroEnvio('Não foi possível enviar. Seu rascunho foi preservado.');
      }
    };
    if (!arquivoDoEnvio) enviarComDados(null);
    else {
      const reader = new FileReader(); leitorRef.current = reader;
      reader.onload = () => { leitorRef.current = null; enviarComDados(reader.result); };
      reader.onerror = () => { leitorRef.current = null; setEnviando(false); setErroEnvio('Não foi possível ler o arquivo. Selecione-o novamente.'); };
      reader.readAsDataURL(arquivoDoEnvio);
    }
  }
  const filtradas = busca.trim() ? mensagens.filter((message) => `${message.conteudo || ''} ${message.autor || ''} ${message.anexo_nome || ''}`.toLocaleLowerCase('pt-BR').includes(busca.trim().toLocaleLowerCase('pt-BR'))) : mensagens;
  return <section className="content social-workspace social-chat">
    <header className="social-header">
      <span className="social-header__symbol"><SocialIcon name={canal.tipo === 'texto' ? 'hash' : 'sound'} /></span>
      <h1>{canal.nome}</h1>
      {canal.descricao && <><span className="social-header__separator" /><p className="social-header__description">{canal.descricao}</p></>}
      <div className="social-header__actions">
        {onToggleMembros && <button type="button" onClick={onToggleMembros} aria-pressed={membrosVisiveis} aria-label={membrosVisiveis ? 'Ocultar membros' : 'Mostrar membros'} title="Lista de membros"><SocialIcon name="friends" /></button>}
        {canal.tipo === 'texto' && <button type="button" aria-label="Buscar nesta conversa" title="Buscar nesta conversa" aria-expanded={buscaAberta} onClick={() => { setBuscaAberta((atual) => !atual); setBusca(''); }}><SocialIcon name="search" /></button>}
      </div>
    </header>
    {canal.tipo === 'texto' ? <>
      {buscaAberta && <label className="social-search social-chat__search"><SocialIcon name="search" size={18} /><input type="search" value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Buscar nas mensagens carregadas" aria-label="Buscar nas mensagens carregadas" autoFocus /><span>{filtradas.length} resultados</span></label>}
      <div className="social-chat__history">
        {!conectado && <p className="social-feedback" role="status">Conexão: {statusConexao || 'desconectado'}</p>}
        {carregando && <p className="social-feedback" role="status">Carregando mensagens…</p>}
        {erroHistorico && <div className="social-feedback social-feedback--error" role="alert"><span>{erroHistorico}</span><button type="button" onClick={() => setTentativa((valor) => valor + 1)}>Tentar novamente</button></div>}
        {!carregando && <SocialMessageList messages={filtradas} preferences={prefs} endRef={fimDaLista} resolveAuthor={(message) => ({ name: message.autor || (sameSocialId(message.usuario_id, meuUsuarioId) ? nomeUsuario : 'Usuário'), avatarUrl: message.avatar_url, avatarColor: message.avatar_cor })} canDelete={(message) => podeApagarMensagens || sameSocialId(message.usuario_id, meuUsuarioId)} onDelete={(mensagemId) => socket?.emit('apagar-mensagem', { canalId: canal.id, mensagemId })} emptyTitle={busca ? 'Nenhuma mensagem encontrada' : `Boas-vindas a #${canal.nome}!`} emptyDescription={busca ? 'Tente outro termo nas mensagens carregadas.' : `Este é o começo do canal #${canal.nome}.`} />}
      </div>
      <SocialComposer value={texto} onChange={setTexto} onSubmit={enviar} placeholder={`Conversar em #${canal.nome}`} preferences={prefs} sending={enviando} error={erroEnvio} connected={conectado} attachment={arquivo} inputRef={inputArquivo} onAttachment={(event) => { setArquivo(event.target.files?.[0] || null); setErroEnvio(''); }} onRemoveAttachment={() => { setArquivo(null); if (inputArquivo.current) inputArquivo.current.value = ''; }} />
    </> : <div className="social-empty"><SocialIcon name="sound" size={56} /><h2>{canal.nome}</h2><p>Use os controles de voz para conversar neste canal.</p></div>}
  </section>;
}
