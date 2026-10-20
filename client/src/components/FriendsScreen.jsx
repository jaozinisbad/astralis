import React, { useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import { SocialIcon } from './SocialMessageParts.jsx';
import './SocialWorkspace.css';

function FriendActionIcon({ name }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'call' ? <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z" />
      : name === 'accept' ? <path d="m5 12 4 4L19 6" />
        : <><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a7 7 0 0 1 11-5.7M16 15l6 6M22 15l-6 6" /></>}
  </svg>;
}

export default function FriendsScreen({
  amigos = [], pedidos = { recebidos: [], enviados: [] }, meuUsuario,
  onAbrirDM, onAdicionarAmigo, onAceitarPedido, onRecusarPedido, onRemoverAmigo, onLigar,
  onEntrarNaConta, carregando = false, erro = '', onTentarNovamente,
}) {
  const [busca, setBusca] = useState('');
  const [aba, setAba] = useState('online');
  const [destinatario, setDestinatario] = useState('');
  const [acao, setAcao] = useState('');
  const [feedback, setFeedback] = useState(null);
  const acaoRef = useRef(false);
  const [prefs] = useInterfacePreferences();
  const recebidos = pedidos.recebidos || [];
  const enviados = pedidos.enviados || [];
  const totalPedidos = recebidos.length + enviados.length;
  const ocupado = carregando || Boolean(acao);
  const online = amigos.filter((amigo) => amigo.online);
  const filtrados = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    return amigos.filter((amigo) => (aba !== 'online' || amigo.online) &&
      (!termo || amigo.nome.toLocaleLowerCase('pt-BR').includes(termo)));
  }, [amigos, busca, aba]);
  const nome = (amigo) => prefs.streamerMode ? 'Amigo' : amigo.nome;

  function trocarAba(proxima) {
    setAba(proxima);
    setFeedback(null);
  }

  async function executar(chave, callback, mensagem) {
    if (acaoRef.current || carregando) return false;
    if (onEntrarNaConta) {
      onEntrarNaConta();
      return false;
    }
    if (!callback) return false;
    acaoRef.current = true;
    setAcao(chave);
    setFeedback(null);
    try {
      await callback();
      if (mensagem) setFeedback({ tipo: 'success', texto: mensagem });
      return true;
    } catch (error) {
      setFeedback({ tipo: 'error', texto: error?.message || 'Não foi possível concluir. Tente novamente.' });
      return false;
    } finally {
      acaoRef.current = false;
      setAcao('');
    }
  }

  async function adicionar(event) {
    event.preventDefault();
    if (!destinatario.trim()) return;
    const enviado = await executar('adicionar', onAdicionarAmigo && (() => onAdicionarAmigo(destinatario.trim())), 'Pedido de amizade enviado. Ele aparecerá em Pendentes até ser aceito.');
    if (enviado) setDestinatario('');
  }

  function avatar(usuario, presence = false) {
    return <span className="social-friend__avatar">
      <Avatar nome={nome(usuario)} avatarUrl={prefs.streamerMode ? null : usuario.avatar_url} avatarCor={usuario.avatar_cor || 'var(--as-accent)'} />
      {presence && <span className={`social-presence ${usuario.online ? 'social-presence--online' : ''}`} aria-hidden="true" />}
    </span>;
  }

  function pedidosLista(lista, entrada) {
    return lista.map((pedido) => <div className="social-friend social-friend--request" role="listitem" key={`${entrada ? 'recebido' : 'enviado'}-${pedido.id}`}>
      {avatar(pedido.usuario)}
      <span className="social-friend__info"><strong>{nome(pedido.usuario)}</strong><span>{entrada ? 'Pedido recebido' : 'Pedido enviado'}</span></span>
      <div className="social-friend__actions">
        {entrada && <button type="button" className="social-friend__action social-friend__action--accept" disabled={ocupado || !onAceitarPedido} aria-label={`Aceitar pedido de ${nome(pedido.usuario)}`} title="Aceitar pedido" onClick={() => executar(`aceitar-${pedido.id}`, () => onAceitarPedido(pedido.id), 'Pedido aceito. Vocês já podem conversar e ligar.')}><FriendActionIcon name="accept" /></button>}
        <button type="button" className="social-friend__action social-friend__action--remove" disabled={ocupado || !onRecusarPedido} aria-label={`${entrada ? 'Recusar pedido de' : 'Cancelar pedido para'} ${nome(pedido.usuario)}`} title={entrada ? 'Recusar pedido' : 'Cancelar pedido'} onClick={() => executar(`recusar-${pedido.id}`, () => onRecusarPedido(pedido.id), entrada ? 'Pedido recusado.' : 'Pedido cancelado.')}><SocialIcon name="close" size={19} /></button>
      </div>
    </div>);
  }

  return (
    <section className="content social-workspace social-friends">
      <header className="social-header social-friends__header">
        <span className="social-header__title"><SocialIcon name="friends" /><span>Amigos</span></span>
        <span className="social-header__separator" aria-hidden="true" />
        <nav className="social-friends__tabs" aria-label="Filtrar amigos">
          <button type="button" aria-pressed={aba === 'online'} onClick={() => trocarAba('online')}>Online</button>
          <button type="button" aria-pressed={aba === 'todos'} onClick={() => trocarAba('todos')}>Todos</button>
          <button type="button" aria-pressed={aba === 'pendentes'} onClick={() => trocarAba('pendentes')}>Pendentes{totalPedidos > 0 && <span className="social-friends__badge" aria-label={`${totalPedidos} pedidos`}>{totalPedidos}</span>}</button>
          <button type="button" className="social-friends__add" aria-pressed={aba === 'adicionar'} onClick={() => trocarAba('adicionar')}>Adicionar amigo</button>
        </nav>
      </header>
      <div className="social-friends__layout">
        <main className="social-friends__main" aria-busy={ocupado}>
          {erro && <div className="social-feedback social-feedback--error" role="alert"><span>{erro}</span>{onTentarNovamente && <button type="button" onClick={onTentarNovamente} disabled={carregando}>Tentar novamente</button>}</div>}
          {feedback && <p className={`social-feedback social-feedback--${feedback.tipo}`} role={feedback.tipo === 'error' ? 'alert' : 'status'}>{feedback.texto}</p>}
          {aba === 'adicionar' ? (
            <section className="social-friends__invite">
              <h1>ADICIONAR AMIGO</h1>
              <p>Adicione pelo nome ou código do Astralis para conversar, ligar e compartilhar a tela.</p>
              {onEntrarNaConta ? (
                <div className="social-friends__invite-box"><SocialIcon name="friends" size={40} /><h2>Encontre sua turma.</h2><p>Entre na sua conta para enviar e receber pedidos de amizade.</p><button type="button" className="social-primary" onClick={onEntrarNaConta}>Entrar na conta</button></div>
              ) : (
                <>
                  <form className="social-friends__add-form" onSubmit={adicionar}>
                    <label htmlFor="friend-name">Nome ou código do amigo</label>
                    <div className="social-friends__add-input">
                      <input id="friend-name" type={prefs.streamerMode ? 'password' : 'text'} value={destinatario} onChange={(event) => { setDestinatario(event.target.value); setFeedback(null); }} placeholder="nome, #123 ou nome#123" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={ocupado} required aria-describedby="friend-name-help" />
                      <button type="submit" className="social-primary" disabled={ocupado || !destinatario.trim() || !onAdicionarAmigo}>{acao === 'adicionar' ? 'Enviando…' : 'Enviar pedido de amizade'}</button>
                    </div>
                    <p id="friend-name-help">Use o nome exato. Se houver nomes iguais, peça o código no formato nome#123 ou #123.</p>
                  </form>
                  {meuUsuario?.id != null && <div className="social-friends__own-code"><span>Seu código de amizade</span><strong>{prefs.streamerMode ? 'Oculto no modo streamer' : `${meuUsuario.nome}#${meuUsuario.id}`}</strong><p>Compartilhe este código para receber pedidos.</p></div>}
                  <div className="social-friends__invite-box"><SocialIcon name="friends" size={40} /><h2>Uma conversa só de vocês.</h2><p>Assim que o pedido for aceito, use o botão de telefone na lista ou na conversa. A transmissão fica dentro da chamada.</p></div>
                </>
              )}
            </section>
          ) : aba === 'pendentes' ? (
            <>
              <h1 className="social-friends__count">PENDENTES — {totalPedidos}</h1>
              {totalPedidos > 0 ? <div className="social-friends__list" role="list" aria-label="Pedidos de amizade">{pedidosLista(recebidos, true)}{pedidosLista(enviados, false)}</div>
                : !carregando && !erro && <div className="social-empty social-friends__empty" role="status"><SocialIcon name="friends" size={52} /><h2>Nenhum pedido pendente</h2><p>Pedidos recebidos e enviados aparecem aqui.</p><button type="button" className="social-primary" onClick={onEntrarNaConta || (() => trocarAba('adicionar'))}>{onEntrarNaConta ? 'Entrar na conta' : 'Encontrar amigos'}</button></div>}
            </>
          ) : (
            <>
              <label className="social-search">
                <input type="search" value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Buscar" aria-label="Buscar amigos pelo nome" />
                {busca ? <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"><SocialIcon name="close" size={18} /></button> : <SocialIcon name="search" size={18} />}
              </label>
              <h1 className="social-friends__count">{aba === 'online' ? 'ONLINE' : 'TODOS OS AMIGOS'} — {filtrados.length}</h1>
              {filtrados.length > 0 ? (
                <div className="social-friends__list" role="list" aria-label="Lista de amigos">
                  {filtrados.map((amigo) => (
                    <div key={amigo.id} className="social-friend" role="listitem">
                      {avatar(amigo, true)}
                      <span className="social-friend__info"><strong>{nome(amigo)}</strong><span>{prefs.streamerMode ? (amigo.online ? 'Online' : 'Offline') : amigo.status || (amigo.online ? 'Online' : 'Offline')}</span></span>
                      <div className="social-friend__actions">
                        <button type="button" className="social-friend__action" onClick={() => onAbrirDM?.(amigo)} aria-label={`Conversar com ${nome(amigo)}`} title="Enviar mensagem" disabled={!onAbrirDM}><SocialIcon name="message" size={20} /></button>
                        {onLigar && <button type="button" className="social-friend__action" onClick={() => executar(`ligar-${amigo.id}`, () => onLigar(amigo))} aria-label={`Ligar para ${nome(amigo)}`} title={amigo.online ? 'Iniciar chamada' : 'Amigo offline'} disabled={ocupado || !amigo.online}><FriendActionIcon name="call" /></button>}
                        {onRemoverAmigo && <button type="button" className="social-friend__action social-friend__action--remove" onClick={() => executar(`remover-${amigo.id}`, () => onRemoverAmigo(amigo.id), 'Amizade removida.')} aria-label={`Remover ${nome(amigo)} dos amigos`} title="Remover amigo" disabled={ocupado}><FriendActionIcon name="remove" /></button>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : !carregando && !erro && (
                <div className="social-empty social-friends__empty" role="status">
                  <img className="social-empty__mark" src="./astralis-mark.svg" alt="" aria-hidden="true" />
                  <h2>{busca ? 'Nenhum amigo encontrado' : amigos.length ? 'Está tudo tranquilo por aqui.' : 'A sua turma começa aqui.'}</h2>
                  <p>{busca ? 'Tente buscar por outro nome.' : amigos.length ? 'Seus amigos aparecerão aqui quando ficarem online.' : 'Adicione seus amigos para conversar, ligar e transmitir a tela diretamente.'}</p>
                  {!busca && amigos.length > 0 && <button type="button" className="social-primary" onClick={() => trocarAba('todos')}>Ver todos os amigos</button>}
                  {!busca && amigos.length === 0 && <button type="button" className="social-primary" onClick={onEntrarNaConta || (() => trocarAba('adicionar'))}>{onEntrarNaConta ? 'Entrar na conta' : 'Encontrar amigos'}</button>}
                </div>
              )}
            </>
          )}
          {carregando && <p className="social-friends__loading" role="status">Carregando amigos…</p>}
        </main>
        <aside className="social-activity" aria-label="Amigos online agora">
          <h2>Ativo agora</h2>
          {online.length ? <>
            <p className="social-activity__description">Disponíveis para conversar</p>
            {online.map((amigo) => <button type="button" className="social-activity__friend" key={amigo.id} onClick={() => onAbrirDM?.(amigo)} disabled={!onAbrirDM}>
              <Avatar nome={nome(amigo)} avatarUrl={prefs.streamerMode ? null : amigo.avatar_url} avatarCor={amigo.avatar_cor || 'var(--as-accent)'} tamanho="sm" />
              <span><strong>{nome(amigo)}</strong><small><span className="social-activity__dot" /> Online no Astralis</small></span>
            </button>)}
          </> : !erro && !carregando && <div className="social-activity__empty"><strong>Por enquanto está quieto…</strong><p>Quando seus amigos estiverem online, você poderá encontrá-los aqui.</p></div>}
        </aside>
      </div>
    </section>
  );
}
