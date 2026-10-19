import React, { useMemo, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import { SocialIcon } from './SocialMessageParts.jsx';
import './SocialWorkspace.css';

export default function FriendsScreen({ amigos = [], onAbrirDM, onAdicionarAmigos, onEntrarNaConta }) {
  const [busca, setBusca] = useState('');
  const [aba, setAba] = useState('online');
  const [prefs] = useInterfacePreferences();
  const online = amigos.filter((amigo) => amigo.online);
  const filtrados = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    return amigos.filter((amigo) => (aba !== 'online' || amigo.online) &&
      (!termo || amigo.nome.toLocaleLowerCase('pt-BR').includes(termo)));
  }, [amigos, busca, aba]);
  const nome = (amigo) => prefs.streamerMode ? 'Amigo' : amigo.nome;

  return (
    <section className="content social-workspace social-friends">
      <header className="social-header social-friends__header">
        <span className="social-header__title"><SocialIcon name="friends" /><span>Amigos</span></span>
        <span className="social-header__separator" aria-hidden="true" />
        <nav className="social-friends__tabs" aria-label="Filtrar amigos">
          <button type="button" aria-pressed={aba === 'online'} onClick={() => setAba('online')}>Online</button>
          <button type="button" aria-pressed={aba === 'todos'} onClick={() => setAba('todos')}>Todos</button>
          <button type="button" className="social-friends__add" aria-pressed={aba === 'adicionar'} onClick={() => setAba('adicionar')}>Adicionar amigo</button>
        </nav>
      </header>
      <div className="social-friends__layout">
        <main className="social-friends__main">
          {aba === 'adicionar' ? (
            <section className="social-friends__invite">
              <h1>ADICIONAR AMIGO</h1>
              <p>Seus amigos no Astralis são as pessoas que compartilham um servidor com você.</p>
              <div className="social-friends__invite-box">
                <SocialIcon name="friends" size={40} />
                <h2>Um convite aproxima sua turma.</h2>
                <p>Entre com o código de um servidor ou crie um e compartilhe o convite. As pessoas de lá aparecem aqui automaticamente.</p>
                {(onEntrarNaConta || onAdicionarAmigos) && <button type="button" className="social-primary" onClick={onEntrarNaConta || onAdicionarAmigos}>{onEntrarNaConta ? 'Entrar na conta' : 'Criar ou entrar em servidor'}</button>}
              </div>
            </section>
          ) : (
            <>
              <label className="social-search">
                <input type="search" value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Buscar" aria-label="Buscar amigos pelo nome" />
                {busca ? <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"><SocialIcon name="close" size={18} /></button> : <SocialIcon name="search" size={18} />}
              </label>
              <h1 className="social-friends__count">{aba === 'online' ? 'ONLINE' : 'TODOS OS AMIGOS'} — {filtrados.length}</h1>
              {filtrados.length > 0 ? (
                <div className="social-friends__list">
                  {filtrados.map((amigo) => (
                    <button key={amigo.id} className="social-friend" type="button" onClick={() => onAbrirDM?.(amigo)} aria-label={`Conversar com ${nome(amigo)}`}>
                      <span className="social-friend__avatar"><Avatar nome={nome(amigo)} avatarUrl={prefs.streamerMode ? null : amigo.avatar_url} avatarCor={amigo.avatar_cor || 'var(--as-accent)'} /><span className={`social-presence ${amigo.online ? 'social-presence--online' : ''}`} aria-hidden="true" /></span>
                      <span className="social-friend__info"><strong>{nome(amigo)}</strong><span>{prefs.streamerMode ? (amigo.online ? 'Online' : 'Offline') : amigo.status || (amigo.online ? 'Online' : 'Offline')}</span></span>
                      <span className="social-friend__message" aria-hidden="true"><SocialIcon name="message" size={20} /></span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="social-empty social-friends__empty" role="status">
                  <img className="social-empty__mark" src="./astralis-mark.svg" alt="" aria-hidden="true" />
                  <h2>{busca ? 'Nenhum amigo encontrado' : amigos.length ? 'Está tudo tranquilo por aqui.' : 'A sua turma começa aqui.'}</h2>
                  <p>{busca ? 'Tente buscar por outro nome.' : amigos.length ? 'Seus amigos aparecerão aqui quando ficarem online.' : 'Compartilhe um servidor para encontrar seus amigos e conversar.'}</p>
                  {!busca && amigos.length > 0 && <button type="button" className="social-primary" onClick={() => setAba('todos')}>Ver todos os amigos</button>}
                  {!busca && amigos.length === 0 && (onEntrarNaConta || onAdicionarAmigos) && <button type="button" className="social-primary" onClick={onEntrarNaConta || onAdicionarAmigos}>{onEntrarNaConta ? 'Entrar na conta' : 'Criar ou entrar em servidor'}</button>}
                </div>
              )}
            </>
          )}
        </main>
        <aside className="social-activity" aria-label="Amigos online agora">
          <h2>Ativo agora</h2>
          {online.length ? <>
            <p className="social-activity__description">Disponíveis para conversar</p>
            {online.map((amigo) => <button type="button" className="social-activity__friend" key={amigo.id} onClick={() => onAbrirDM?.(amigo)}>
              <Avatar nome={nome(amigo)} avatarUrl={prefs.streamerMode ? null : amigo.avatar_url} avatarCor={amigo.avatar_cor || 'var(--as-accent)'} tamanho="sm" />
              <span><strong>{nome(amigo)}</strong><small><span className="social-activity__dot" /> Online no Astralis</small></span>
            </button>)}
          </> : <div className="social-activity__empty"><strong>Por enquanto está quieto…</strong><p>Quando seus amigos estiverem online, você poderá encontrá-los aqui.</p></div>}
        </aside>
      </div>
    </section>
  );
}
