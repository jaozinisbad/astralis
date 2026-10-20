import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import VoiceConnectionPanel from './VoiceConnectionPanel.jsx';

export function WorkspaceIcon({ name, size = 20, muted = false }) {
  const icons = {
    friends: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    settings: <><path d="m9.5 3-.6 2.4-2 .9-2.2-.7-2.5 4.3 1.8 1.7v2.3l-1.8 1.7 2.5 4.3 2.3-.7 2 .9.5 2.4h5l.6-2.4 2-.9 2.2.7 2.5-4.3-1.8-1.7v-2.3l1.8-1.7-2.5-4.3-2.3.7-2-.9-.5-2.4z"/><circle cx="12" cy="12" r="3"/></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
    headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name] || icons.friends}{muted && <path d="m3 3 18 18" strokeWidth="2.2"/>}</svg>;
}

export function UserDock({ usuario, onPerfil, onSettings, voice, voiceActions, connected }) {
  const [prefs] = useInterfacePreferences();
  const name = prefs.streamerMode && usuario ? 'Usuário' : usuario?.nome || 'Visitante';
  return <footer className="home-sidebar__footer user-panel">
    <button type="button" className="user-panel__profile" onClick={onPerfil} aria-label={usuario ? 'Abrir meu perfil' : 'Entrar na conta'}>
      <span className="user-panel__avatar"><Avatar nome={name} avatarCor={usuario?.avatarCor || '#9270f4'} avatarUrl={prefs.streamerMode ? null : usuario?.avatarUrl} tamanho="32px"/><i className={connected ? 'is-online' : ''}/></span>
      <span className="user-panel__identity"><strong>{name}</strong><small>{usuario ? connected ? 'Disponível' : 'Desconectado' : 'Entrar na conta'}</small></span>
    </button>
    <div className="user-panel__actions">
      <button type="button" className={voice?.micMudo ? 'is-muted' : ''} disabled={typeof voiceActions?.onAlternarMic !== 'function'} onClick={voiceActions?.onAlternarMic} aria-pressed={Boolean(voice?.micMudo)} aria-label={voice?.micMudo ? 'Ativar microfone' : 'Silenciar microfone'} title={voiceActions ? voice?.micMudo ? 'Ativar microfone' : 'Silenciar microfone' : 'Entre em um canal de voz para usar o microfone'}><WorkspaceIcon name="mic" size={18} muted={voice?.micMudo}/></button>
      <button type="button" className={voice?.audioMudo ? 'is-muted' : ''} disabled={typeof voiceActions?.onAlternarAudio !== 'function'} onClick={voiceActions?.onAlternarAudio} aria-pressed={Boolean(voice?.audioMudo)} aria-label={voice?.audioMudo ? 'Ativar áudio' : 'Desativar áudio'} title={voiceActions ? voice?.audioMudo ? 'Ativar áudio' : 'Desativar áudio' : 'Entre em um canal de voz para ouvir a chamada'}><WorkspaceIcon name="headphones" size={18} muted={voice?.audioMudo}/></button>
      <button type="button" onClick={onSettings} aria-label="Configurações de usuário" title="Configurações de usuário"><WorkspaceIcon name="settings" size={18}/></button>
    </div>
  </footer>;
}

export default function HomeSidebar({ view, amigos = [], servidores = [], canais = [], dmAtiva, usuario, onAmigos, onDM, onServidor, onCanal, onPerfil, onSettings, voice, voiceActions, voiceChannel, connected }) {
  const [prefs] = useInterfacePreferences();
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('astralis:focus-search', focus);
    return () => window.removeEventListener('astralis:focus-search', focus);
  }, []);
  const search = query.trim().toLocaleLowerCase('pt-BR');
  const matches = (name) => String(name).toLocaleLowerCase('pt-BR').includes(search);
  function choose(action) { setQuery(''); action(); }
  return <aside className="home-sidebar" aria-label="Página inicial e mensagens diretas">
    <div className="home-sidebar__search"><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Encontrar conversa, canal ou servidor" placeholder="Encontre ou comece uma conversa"/></div>
    <nav className="home-sidebar__nav" aria-label="Navegação principal">
      <button type="button" className={`home-sidebar__item${view === 'amigos' ? ' active' : ''}`} aria-current={view === 'amigos' ? 'page' : undefined} onClick={onAmigos}><WorkspaceIcon name="friends"/><span>Amigos</span></button>
    </nav>
    <div className="home-sidebar__heading"><span>{search ? 'RESULTADOS DA BUSCA' : 'MENSAGENS DIRETAS'}</span><button type="button" onClick={onAmigos} aria-label="Encontrar pessoas" title="Encontrar pessoas">+</button></div>
    <div className="home-sidebar__conversations">
      {amigos.filter((friend) => !search || matches(friend.nome)).map((friend) => <button type="button" key={friend.id} className={`home-sidebar__dm${dmAtiva?.id === friend.id && view === 'dm' ? ' active' : ''}`} onClick={() => choose(() => onDM(friend))}>
        <span className="home-sidebar__dm-avatar"><Avatar nome={prefs.streamerMode ? 'Amigo' : friend.nome} avatarCor={friend.avatar_cor} avatarUrl={prefs.streamerMode ? null : friend.avatar_url} tamanho="32px"/><i className={friend.online ? 'is-online' : ''}/></span><span>{prefs.streamerMode ? 'Conversa privada' : friend.nome}</span>
      </button>)}
      {search && servidores.filter((server) => matches(server.nome)).map((server) => <button type="button" className="home-sidebar__dm" key={`server-${server.id}`} onClick={() => choose(() => onServidor(server.id))}><span className="home-sidebar__result-icon">{server.nome.slice(0, 2)}</span><span>{server.nome}<small>Servidor</small></span></button>)}
      {search && canais.filter((channel) => matches(channel.nome)).map((channel) => <button type="button" className="home-sidebar__dm" key={`channel-${channel.id}`} onClick={() => choose(() => onCanal(channel))}><span className="home-sidebar__result-icon">#</span><span>{channel.nome}<small>Canal</small></span></button>)}
      {!amigos.length && !search && <p className="home-sidebar__empty">Adicione amigos para conversar e ligar sem precisar de um servidor.</p>}
      {search && ![...amigos, ...servidores, ...canais].some((item) => matches(item.nome)) && <p className="home-sidebar__empty" role="status">Nenhum resultado para “{query}”.</p>}
    </div>
    {!usuario && <div className="home-sidebar__guest"><strong>Seu espaço começa aqui.</strong><p>Entre para conversar e criar servidores.</p><button type="button" onClick={onPerfil}>Entrar no Astralis</button></div>}
    <VoiceConnectionPanel channel={voiceChannel} state={voice} actions={voiceActions || undefined}/>
    <UserDock usuario={usuario} onPerfil={onPerfil} onSettings={onSettings} voice={voice} voiceActions={voiceActions} connected={connected}/>
  </aside>;
}
