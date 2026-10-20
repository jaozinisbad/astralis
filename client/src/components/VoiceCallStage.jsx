import React, { useRef } from 'react';
import Avatar from './Avatar.jsx';
import { getVoicePanelStatus } from './VoiceConnectionPanel.jsx';
import './VoiceCallStage.css';

export function CallIcon({ name, size = 24 }) {
  const icons = {
    phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z" />,
    voice: <><path d="m11 5-6 4H2v6h3l6 4V5Z" /><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" /></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    micOff: <><path d="m2 2 20 20M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.8-1M5 10v2a7 7 0 0 0 12 4.9M19 12v-2M12 19v3M8 22h8" /></>,
    headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3" /><rect x="3" y="12" width="4" height="9" rx="2" /><rect x="17" y="12" width="4" height="9" rx="2" /></>,
    headphonesOff: <><path d="m2 2 20 20M3 14v-3a9 9 0 0 1 1-4M7 3a9 9 0 0 1 14 8v3" /><rect x="3" y="12" width="4" height="9" rx="2" /><path d="M17 17v2a2 2 0 0 0 3.4 1.4M21 16v-2a2 2 0 0 0-2-2h-2v1" /></>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M8 10l4-4 4 4M12 6v8" /></>,
    stop: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M9 7h6v6H9z" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    disconnect: <><path d="M3 15.5c0-6 18-6 18 0v3l-5-1.5v-3M8 14v3L3 18.5" /></>,
    settings: <><path d="m9 3-.7 2.2-2 .9-2.1-.5-1.5 2.6L4 10v2l-1.3 1.8 1.5 2.6 2.1-.5 2 .9L9 19h3l.7-2.2 2-.9 2.1.5 1.5-2.6L17 12v-2l1.3-1.8-1.5-2.6-2.1.5-2-.9L12 3H9Z" /><circle cx="10.5" cy="11" r="3" /></>,
    expand: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>;
}

export default function VoiceCallStage({ canal, participantes, socketId, micMudo, audioMudo, conectando, connectionState, compartilhamentoPendente, erro, erroCompartilhamento,
  compartilhandoTela, streamSelecionada, telaSelecionadaId, telaLocalSelecionada, participanteSelecionado,
  telasRemotas, telaTileRef, emTelaCheia, telasMutadas, volumesTelas,
  onAlternarMic, onAlternarAudio, onCompartilharTela, onPararCompartilhamento, onDesconectar, onAbrirConfiguracoes,
  onSelecionarTela, onFecharTela, onTelaCheia, onMutarTela, onVolumeTela, onAbrirConversa }) {
  const menuRef = useRef(null);
  const connection = getVoicePanelStatus({ connectionState, conectando, erro });
  const status = connection.label;
  const canShare = connection.id === 'connected' && !compartilhamentoPendente && Boolean(onCompartilharTela);
  function menuAction(action) {
    if (menuRef.current) menuRef.current.open = false;
    action?.();
  }
  function ParticipantTile({ participant, compact = false }) {
    const local = participant.socketId === socketId;
    const live = local ? compartilhandoTela : Boolean(telasRemotas[participant.socketId]);
    return <article className={`voice-participant${local ? ' voice-participant--local' : ''}${compact ? ' voice-participant--compact' : ''}`} data-participant-socket={participant.socketId}>
      <div className="voice-participant__center"><Avatar nome={participant.nome || 'Participante'} avatarUrl={participant.avatarUrl} avatarCor={participant.avatarCor || 'var(--as-accent, #9270f4)'} tamanho={compact ? 'md' : 'xl'} /></div>
      <div className="voice-participant__meta"><strong className="voice-participant__name">{participant.nome || 'Participante'}{local && <small> (você)</small>}</strong><span className="voice-participant__status">{local ? connection.id !== 'connected' ? status : audioMudo ? 'Áudio desativado' : micMudo ? 'Microfone silenciado' : 'Na chamada' : 'Na chamada'}</span></div>
      {local && (micMudo || audioMudo) && <span className="voice-participant__muted" title={audioMudo ? 'Áudio desativado' : 'Microfone silenciado'}><CallIcon name={audioMudo ? 'headphonesOff' : 'micOff'} size={18} /></span>}
      {live && <button type="button" className={`voice-participant__watch${telaSelecionadaId === participant.socketId ? ' voice-participant__watch--active' : ''}`} onClick={() => onSelecionarTela(participant.socketId)} aria-label={`${telaSelecionadaId === participant.socketId ? 'Fechar transmissão de' : 'Assistir transmissão de'} ${participant.nome || 'Participante'}`}><span className="voice-live-badge">AO VIVO</span><span>{telaSelecionadaId === participant.socketId ? 'Assistindo' : local ? 'Ver sua tela' : 'Assistir'}</span></button>}
    </article>;
  }
  return <section className="content voice-call-panel voice-call-panel--active voice-stage" aria-label={`Chamada de voz ${canal.nome}`}>
    <header className="voice-stage__header"><CallIcon name="voice" size={22} /><h1>{canal.nome}</h1><span className="voice-stage__header-divider" /><span className="voice-stage__people">{participantes.length} {participantes.length === 1 ? 'participante' : 'participantes'}</span>{onAbrirConversa && <button type="button" className="voice-stage__back" onClick={onAbrirConversa}>Ver conversa</button>}{streamSelecionada && <button type="button" className="voice-stage__back" onClick={onFecharTela}>Voltar aos participantes</button>}</header>
    <div className="voice-stage__body">
      <div className={`voice-stage__connection${connection.id === 'failed' ? ' voice-stage__connection--error' : connection.id === 'connecting' ? ' voice-stage__connection--pending' : ''}`} role={erro ? 'alert' : 'status'}><span />{status}{erro && onAbrirConfiguracoes && <button type="button" onClick={onAbrirConfiguracoes}>Configurações de voz</button>}</div>
      {erro && <p className="voice-stage__error" role="alert">{erro}</p>}
      {erroCompartilhamento && <p className="voice-stage__error" role="alert">{erroCompartilhamento}</p>}
      {streamSelecionada ? <div className="voice-stage__focused">
        <div className="voice-stage__stream tela-tile" key={telaSelecionadaId} ref={telaTileRef}>
          <video autoPlay playsInline muted ref={(element) => { if (element && element.srcObject !== streamSelecionada) element.srcObject = streamSelecionada; }} />
          <div className="voice-stage__stream-label"><span className="voice-live-badge">AO VIVO</span><span className="voice-participant__name">{telaLocalSelecionada ? 'Sua tela (você)' : participanteSelecionado?.nome || 'Transmissão ao vivo'}</span></div>
          <div className="voice-stage__stream-controls">
            {!telaLocalSelecionada && <><label className="voice-stage__volume"><span>Volume {Math.round(volumesTelas[telaSelecionadaId] ?? 100)}%</span><input type="range" min="0" max="100" step="1" value={volumesTelas[telaSelecionadaId] ?? 100} aria-label={`Volume da transmissão de ${participanteSelecionado?.nome || 'Alguém'}`} onChange={(event) => onVolumeTela(telaSelecionadaId, event.target.valueAsNumber)} /></label><button type="button" onClick={() => onMutarTela(telaSelecionadaId)} aria-label={telasMutadas.has(telaSelecionadaId) ? 'Ativar o áudio dessa tela' : 'Mutar o áudio dessa tela'}>{telasMutadas.has(telaSelecionadaId) ? 'Ativar som' : 'Silenciar'}</button></>}
            <button type="button" onClick={onTelaCheia} title={emTelaCheia ? 'Sair da tela cheia' : 'Abrir a transmissão em tela cheia'} aria-label={emTelaCheia ? 'Sair da tela cheia' : 'Abrir a transmissão em tela cheia'}><CallIcon name="expand" size={18} /></button>
            <button type="button" onClick={onFecharTela} title="Fechar a transmissão sem sair da chamada" aria-label="Fechar transmissão"><CallIcon name="close" size={18} /></button>
          </div>
        </div>
        <div className="voice-stage__filmstrip" aria-label="Participantes da chamada">{participantes.map((participant) => <ParticipantTile key={participant.socketId} participant={participant} compact />)}</div>
      </div> : <div className={`voice-stage__grid${participantes.length === 1 ? ' voice-stage__grid--alone' : ''}`} aria-label="Participantes da chamada">{participantes.map((participant) => <ParticipantTile key={participant.socketId} participant={participant} />)}</div>}
    </div>
    <footer className="voice-stage__footer">
      <div className="voice-stage__controls" aria-label="Controles da chamada">
        <button type="button" className={`voice-stage__control${micMudo ? ' voice-stage__control--off' : ''}`} disabled={connection.id !== 'connected'} onClick={onAlternarMic} title={micMudo ? 'Ativar microfone' : 'Silenciar microfone'} aria-label={micMudo ? 'Ativar microfone' : 'Silenciar microfone'} aria-pressed={micMudo}><CallIcon name={micMudo ? 'micOff' : 'mic'} /></button>
        <button type="button" className={`voice-stage__control${audioMudo ? ' voice-stage__control--off' : ''}`} onClick={onAlternarAudio} title={audioMudo ? 'Ativar áudio da chamada' : 'Desativar áudio da chamada'} aria-label={audioMudo ? 'Ativar áudio da chamada' : 'Desativar áudio da chamada'} aria-pressed={audioMudo}><CallIcon name={audioMudo ? 'headphonesOff' : 'headphones'} /></button>
        <div className={`voice-stage__share${compartilhandoTela ? ' voice-stage__share--active' : ''}`}>
          <button type="button" className="voice-stage__control" disabled={!compartilhandoTela && !canShare} onClick={compartilhandoTela ? onPararCompartilhamento : onCompartilharTela} title={compartilhandoTela ? 'Parar compartilhamento de tela' : 'Compartilhar sua tela'} aria-label={compartilhandoTela ? 'Parar compartilhamento de tela' : 'Compartilhar sua tela'}><CallIcon name={compartilhandoTela ? 'stop' : 'monitor'} /></button>
          {(onCompartilharTela || compartilhandoTela || onAbrirConfiguracoes) && <details className="voice-stage__share-menu" ref={menuRef}><summary aria-label="Opções de compartilhamento de tela" title="Opções de compartilhamento de tela"><CallIcon name="chevron" size={16} /></summary><div className="voice-stage__share-popover">
            {compartilhandoTela ? <><button type="button" disabled={!canShare} onClick={() => menuAction(onCompartilharTela)}><CallIcon name="monitor" size={18} />Trocar tela ou janela</button><button type="button" onClick={() => menuAction(onPararCompartilhamento)}><CallIcon name="stop" size={18} />Parar compartilhamento</button></> : onCompartilharTela && <button type="button" disabled={!canShare} onClick={() => menuAction(onCompartilharTela)}><CallIcon name="monitor" size={18} />Selecionar tela ou janela</button>}
            {onAbrirConfiguracoes && <button type="button" onClick={() => menuAction(onAbrirConfiguracoes)}><CallIcon name="settings" size={18} />Configurações de voz</button>}
          </div></details>}
        </div>
        {onAbrirConfiguracoes && <button type="button" className="voice-stage__control voice-stage__settings" onClick={onAbrirConfiguracoes} title="Configurações de voz" aria-label="Configurações de voz"><CallIcon name="settings" /></button>}
        <button type="button" className="voice-stage__control voice-stage__control--disconnect" onClick={onDesconectar} title="Desconectar da chamada" aria-label="Desconectar da chamada"><CallIcon name="disconnect" size={26} /></button>
      </div>
      <p className="voice-stage__footer-hint">{compartilhandoTela ? 'Sua tela está sendo compartilhada com esta chamada.' : 'Compartilhe uma tela ou janela usando o monitor.'}</p>
    </footer>
  </section>;
}
