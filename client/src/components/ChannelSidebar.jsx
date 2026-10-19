import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import InviteServerModal from './InviteServerModal.jsx';
import VoiceConnectionPanel from './VoiceConnectionPanel.jsx';

function IconTexto() {
  return <span className="channel-icon" aria-hidden="true">#</span>;
}

function IconVoz() {
  return (
    <span className="channel-icon" aria-hidden="true">
      <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h3l4-4v12l-4-4H3V8ZM13 7a4.5 4.5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/></svg>
    </span>
  );
}

function Icon({ nome, size = 17, muted = false }) {
  const paths = {
    mic: <><rect x="6" y="2" width="6" height="11" rx="3" /><path d="M3.5 9a5.5 5.5 0 0 0 11 0M9 14.5v3M6 17.5h6" /></>,
    audio: <><path d="M3 11V9a7 7 0 0 1 14 0v2"/><rect x="3" y="10" width="3" height="7" rx="1.5"/><rect x="14" y="10" width="3" height="7" rx="1.5"/></>,
    screen: <><rect x="2.5" y="3" width="15" height="11" rx="1.5" /><path d="M7 17h6M10 14v3" /></>,
    settings: <><circle cx="10" cy="10" r="3" /><path d="M10 2v2M10 16v2M18 10h-2M4 10H2M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4M15.7 15.7l-1.4-1.4M5.7 5.7 4.3 4.3" /></>,
    logout: <><path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8" /><path d="m12 6 4 4-4 4M16 10H7" /></>,
    invite: <><circle cx="7" cy="7" r="3" /><path d="M2.5 17c.8-3 2.4-4.5 4.5-4.5s3.7 1.5 4.5 4.5M15 7v6M12 10h6" /></>,
    copy: <><rect x="7" y="7" width="9" height="10" rx="1" /><path d="M13 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /></>,
    trash: <><path d="M3 5h14M8 5V3h4v2M5 5l1 13h8l1-13M8 9v5M12 9v5" /></>,
    call: <><path d="M5.5 3.5 8 6 6.5 8.5a12 12 0 0 0 5 5L14 12l2.5 2.5-1.7 2.2c-.5.6-1.3.8-2 .5A16 16 0 0 1 2.8 7.2c-.3-.7-.1-1.5.5-2L5.5 3.5Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[nome]}{muted && <path d="m2 2 16 16" strokeWidth="2"/>}</svg>;
}

export default function ChannelSidebar({
  servidorNome,
  codigoConvite,
  souDono,
  onExcluirServidor,
  onSairDoServidor,
  minhasPermissoes = {},
  canais = [],
  canalAtivoId,
  onSelecionar,
  usuario,
  onSair,
  onAbrirPerfil,
  onAbrirConfiguracao,
  canalDeVoz, // { id, nome } | null — canal de voz atualmente conectado
  presencaVoz, // { canalId: [{ socketId, nome, avatarCor, avatarUrl, usuarioId }] } — de QUALQUER canal, mesmo sem estar nele
  vozEstado = {}, // { micMudo, audioMudo, compartilhandoTela }
  vozAcoes = {}, // { onAlternarMic, onAlternarAudio, onAlternarTela, onDesconectar }
  nomeUsuarioNaVoz,
  onAbrirServidorConfiguracao,
  onCriarCanal,
  onApagarCanal,
  onExpulsarDaCall,
  onAssistirTransmissao,
}) {
  const [menuServidorAberto, setMenuServidorAberto] = useState(false);
  const [menuPerfilAberto, setMenuPerfilAberto] = useState(false);
  const [conviteAberto, setConviteAberto] = useState(false);
  const [feedbackConvite, setFeedbackConvite] = useState(null);
  const feedbackTimerRef = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => () => window.clearTimeout(feedbackTimerRef.current), []);
  useEffect(() => {
    const fechar = (event) => {
      if (!menuRef.current?.contains(event.target)) {
        setMenuServidorAberto(false);
        setMenuPerfilAberto(false);
      }
    };
    const aoTeclar = (event) => {
      if (event.key === 'Escape') {
        setMenuServidorAberto(false);
        setMenuPerfilAberto(false);
      }
    };
    document.addEventListener('mousedown', fechar);
    document.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('mousedown', fechar);
      document.removeEventListener('keydown', aoTeclar);
    };
  }, []);
  const canaisTexto = canais.filter((c) => c.tipo === 'texto');
  const canaisVoz = canais.filter((c) => c.tipo === 'voz');
  const podeGerenciarCanais = souDono || minhasPermissoes.gerenciar_canais;
  const podeExpulsarCall = souDono || minhasPermissoes.expulsar_call;

  function copiarComSelecao(texto) {
    const campo = document.createElement('textarea');
    campo.value = texto;
    campo.setAttribute('readonly', '');
    campo.style.position = 'fixed';
    campo.style.opacity = '0';
    document.body.appendChild(campo);
    campo.select();
    try {
      return document.execCommand('copy');
    } finally {
      campo.remove();
    }
  }

  async function copiarCodigoConvite() {
    window.clearTimeout(feedbackTimerRef.current);
    try {
      if (window.electronAPI?.copiarTexto) {
        await window.electronAPI.copiarTexto(codigoConvite);
      } else if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(codigoConvite);
        } catch {
          if (!copiarComSelecao(codigoConvite)) throw new Error('A área de transferência não aceitou o código.');
        }
      } else {
        if (!copiarComSelecao(codigoConvite)) throw new Error('A área de transferência não aceitou o código.');
      }
      setFeedbackConvite({ sucesso: true, mensagem: 'Código de convite copiado.' });
      feedbackTimerRef.current = window.setTimeout(() => setFeedbackConvite(null), 6000);
    } catch (err) {
      console.error('Não foi possível copiar o código de convite:', err);
      setFeedbackConvite({ sucesso: false, mensagem: 'Não foi possível copiar. Selecione o código abaixo para copiá-lo manualmente.' });
    } finally {
      setMenuServidorAberto(false);
    }
  }

  return (
    <aside className="channel-sidebar" aria-label={`Canais de ${servidorNome}`} ref={menuRef}>
      <div className="channel-sidebar__header">
        <button type="button" className="server-name-trigger" onClick={() => setMenuServidorAberto((aberto) => !aberto)} aria-expanded={menuServidorAberto}>
          <span>{servidorNome}</span><span className="server-name-trigger__chevron" aria-hidden="true">⌄</span>
        </button>
        {menuServidorAberto && <div className="sidebar-popover server-menu">
          {codigoConvite && <button type="button" onClick={() => { setConviteAberto(true); setMenuServidorAberto(false); }}><Icon nome="invite" />Convidar para o servidor</button>}
          {codigoConvite && <button type="button" onClick={copiarCodigoConvite}><Icon nome="copy" />Copiar código de convite</button>}
          {podeGerenciarCanais && <button type="button" onClick={() => { onCriarCanal('texto'); setMenuServidorAberto(false); }}><span className="menu-plus">+</span>Criar canal de texto</button>}
          {podeGerenciarCanais && <button type="button" onClick={() => { onCriarCanal('voz'); setMenuServidorAberto(false); }}><span className="menu-plus">+</span>Criar canal de voz</button>}
          {(souDono || minhasPermissoes.gerenciar_servidor) && <button type="button" onClick={() => { onAbrirServidorConfiguracao(); setMenuServidorAberto(false); }}><Icon nome="settings" />Configurações do servidor</button>}
          <div className="sidebar-popover__divider" />
          <button type="button" className="sidebar-popover__danger" onClick={() => { setMenuServidorAberto(false); if (window.confirm(souDono ? `Excluir "${servidorNome}"? Isso apaga todos os canais e mensagens.` : `Sair de "${servidorNome}"?`)) souDono ? onExcluirServidor() : onSairDoServidor(); }}><Icon nome={souDono ? 'trash' : 'logout'} />{souDono ? 'Excluir servidor' : 'Sair do servidor'}</button>
        </div>}
      </div>

      {feedbackConvite && <div role="status" aria-live="polite" className="sidebar-feedback" style={{ padding: '8px 12px', color: feedbackConvite.sucesso ? '#9be2c0' : '#ffb6a7', fontSize: 12 }}>
        <div>{feedbackConvite.mensagem}</div>
        {!feedbackConvite.sucesso && <input aria-label="Código de convite para copiar manualmente" readOnly value={codigoConvite} onFocus={(event) => event.target.select()} style={{ width: '100%', marginTop: 6, color: '#fff', background: '#171b2b', border: '1px solid rgba(193,207,245,.25)', padding: 6, userSelect: 'all' }} />}
      </div>}

      {conviteAberto && <InviteServerModal
        servidorNome={servidorNome}
        codigoConvite={codigoConvite}
        onFechar={() => setConviteAberto(false)}
      />}

      <div className="channel-sidebar__list">
        <div className="channel-group-label">
          <span><span className="channel-group-label__chevron" aria-hidden="true">⌄</span>Canais de texto</span>
          {podeGerenciarCanais && (
            <button type="button" className="channel-group-label__add" title="Criar canal de texto" onClick={() => onCriarCanal('texto')}>
              +
            </button>
          )}
        </div>
        {canaisTexto.map((c) => (
          <div
            key={c.id}
            className={`channel-item${c.id === canalAtivoId ? ' active' : ''}`}
          >
            <button type="button" className="channel-item__select" aria-label={`Abrir canal de texto ${c.nome}`} aria-current={c.id === canalAtivoId ? 'page' : undefined} onClick={() => onSelecionar(c)}>
              <IconTexto />
              <span className="channel-item__name">{c.nome}</span>
            </button>
            {podeGerenciarCanais && (
              <button
                type="button"
                className="channel-item__apagar"
                title="Apagar canal"
                aria-label={`Apagar canal ${c.nome}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Apagar o canal #${c.nome}?`)) onApagarCanal(c.id);
                }}
              ><Icon nome="trash" /></button>
            )}
          </div>
        ))}

        <div className="channel-group-label">
          <span><span className="channel-group-label__chevron" aria-hidden="true">⌄</span>Canais de voz</span>
          {podeGerenciarCanais && (
            <button type="button" className="channel-group-label__add" title="Criar canal de voz" onClick={() => onCriarCanal('voz')}>
              +
            </button>
          )}
        </div>
        {canaisVoz.map((c) => {
          const listaPresenca = presencaVoz?.[c.id] || [];
          return (
            <React.Fragment key={c.id}>
              <div
                className={`channel-item${c.id === canalAtivoId ? ' active' : ''}`}
              >
                <button type="button" className="channel-item__select" aria-label={`Abrir canal de voz ${c.nome}`} aria-current={c.id === canalAtivoId ? 'page' : undefined} onClick={() => onSelecionar(c)}>
                  <IconVoz />
                  <span className="channel-item__name">{c.nome}</span>
                  {listaPresenca.length > 0 && <span className="voz-contador-participantes" aria-label={`${listaPresenca.length} participantes`}>{listaPresenca.length}</span>}
                </button>
                {podeGerenciarCanais && (
                  <button
                    type="button"
                    className="channel-item__apagar"
                    title="Apagar canal"
                    aria-label={`Apagar canal ${c.nome}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Apagar o canal ${c.nome}?`)) onApagarCanal(c.id);
                    }}
                  ><Icon nome="trash" /></button>
                )}
              </div>
              {listaPresenca.length > 0 && (
                <div className="voz-participantes-lista">
                  {listaPresenca.map((p) => {
                    const souEu = canalDeVoz?.id === c.id && p.nome === nomeUsuarioNaVoz;
                    const estaAoVivo = canalDeVoz?.id === c.id && vozEstado.telasAtivas?.includes(p.socketId);
                    return (
                      <div key={p.socketId} className="voz-participante-item">
                        <Avatar
                          nome={p.nome}
                          avatarUrl={souEu ? usuario.avatarUrl : p.avatarUrl}
                          avatarCor={souEu ? usuario.avatarCor : p.avatarCor || '#9270f4'}
                          tamanho="sm"
                        />
                        <span className="voz-participante-nome">
                          {p.nome}{souEu ? ' (você)' : ''}
                        </span>
                        {estaAoVivo && (
                          <button
                            type="button"
                            className={`voz-live-badge${vozEstado.telaSelecionadaId === p.socketId ? ' ativo' : ''}`}
                            aria-pressed={vozEstado.telaSelecionadaId === p.socketId}
                            title={`${vozEstado.telaSelecionadaId === p.socketId ? 'Fechar' : 'Assistir'} a transmissão de ${p.nome}`}
                            onClick={() => onAssistirTransmissao?.(p.socketId)}
                          >
                            <span aria-hidden="true" /> AO VIVO
                          </button>
                        )}
                        {!souEu && podeExpulsarCall && (
                          <button
                            type="button"
                            className="channel-item__apagar"
                            title={`Expulsar ${p.nome} da call`}
                            onClick={() => onExpulsarDaCall(c.id, p.usuarioId)}
                          >
                            Remover
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <VoiceConnectionPanel channel={canalDeVoz ? { ...canalDeVoz, servidorNome: canalDeVoz.servidorNome || servidorNome } : null} state={vozEstado} actions={vozAcoes}/>

      <div className="user-panel">
        <button type="button"
          className="user-panel__clicavel"
          onClick={() => setMenuPerfilAberto((aberto) => !aberto)}
          aria-expanded={menuPerfilAberto}
        >
          <Avatar nome={usuario.nome} avatarUrl={usuario.avatarUrl} avatarCor={usuario.avatarCor} tamanho="md" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="user-panel__name">{usuario.nome}</div>
            <div className="user-panel__status">{usuario.status || (usuario.online ? 'Online' : 'Offline')}</div>
          </div>
        </button>
        {menuPerfilAberto && <div className="sidebar-popover profile-menu">
          <button type="button" onClick={() => { onAbrirPerfil(); setMenuPerfilAberto(false); }}><Icon nome="settings" />Personalizar perfil</button>
          <button type="button" onClick={() => { onAbrirConfiguracao(); setMenuPerfilAberto(false); }}><Icon nome="audio" />Configurações de áudio</button>
          <div className="sidebar-popover__divider" />
          <button type="button" className="sidebar-popover__danger" onClick={onSair}><Icon nome="logout" />Sair da conta</button>
        </div>}

        <button
          type="button"
          className={`user-panel__icone${canalDeVoz && vozEstado.micMudo ? ' ativo' : ''}`}
          onClick={vozAcoes.onAlternarMic}
          disabled={!canalDeVoz || typeof vozAcoes.onAlternarMic !== 'function'}
          aria-label={vozEstado.micMudo ? 'Ativar microfone' : 'Silenciar microfone'}
          aria-pressed={Boolean(vozEstado.micMudo)}
          title={canalDeVoz ? (vozEstado.micMudo ? 'Ativar microfone' : 'Mutar microfone') : 'Entre num canal de voz primeiro'}
        >
          <Icon nome="mic" muted={vozEstado.micMudo}/>
        </button>
        <button
          type="button"
          className={`user-panel__icone${canalDeVoz && vozEstado.audioMudo ? ' ativo' : ''}`}
          onClick={vozAcoes.onAlternarAudio}
          disabled={!canalDeVoz || typeof vozAcoes.onAlternarAudio !== 'function'}
          aria-label={vozEstado.audioMudo ? 'Ativar áudio' : 'Desativar áudio'}
          aria-pressed={Boolean(vozEstado.audioMudo)}
          title={canalDeVoz ? (vozEstado.audioMudo ? 'Ativar áudio' : 'Silenciar áudio') : 'Entre num canal de voz primeiro'}
        >
          <Icon nome="audio" muted={vozEstado.audioMudo}/>
        </button>
        <button type="button" className="user-panel__icone" onClick={onAbrirConfiguracao} title="Configurações de usuário" aria-label="Configurações de usuário"><Icon nome="settings" /></button>
      </div>
    </aside>
  );
}
