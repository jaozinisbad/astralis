import React from 'react';
import './VoiceConnectionPanel.css';

export function VoicePanelIcon({ name, size = 19 }) {
  const paths = {
    signal: <><path d="M3 19v-3M8 19v-7M13 19V8M18 19V4" strokeWidth="2.7"/></>,
    disconnect: <><path d="M3 13a15.5 15.5 0 0 1 18 0l-2.5 4-3.5-1v-3a14 14 0 0 0-6 0v3l-3.5 1L3 13Z"/><path d="m5 3 14 18"/></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4m-4-10 4-4 4 4m-4-4v8"/></>,
    stop: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><rect x="9" y="8" width="6" height="5" fill="currentColor" stroke="none"/></>,
    change: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="m9 8-2 2 2 2m-2-2h8m0 0-2-2m2 2-2 2M8 21h8M12 17v4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function getVoicePanelStatus(state = {}) {
  const connection = state.connectionState;
  if (connection === 'failed' || connection === 'disconnected') return { id: 'failed', label: 'Falha na conexão de voz' };
  if (connection === 'connecting' || connection === 'reconnecting' || state.conectando) return { id: 'connecting', label: connection === 'reconnecting' ? 'Reconectando…' : 'Conectando…' };
  if (state.erro) return { id: 'failed', label: 'Falha na conexão de voz' };
  if (connection === 'connected') return { id: 'connected', label: 'Voz conectada' };
  return { id: 'connecting', label: 'Conectando…' };
}

/** The same live call controls remain available in a server, friends or a DM. */
export default function VoiceConnectionPanel({ channel, state = {}, actions = {} }) {
  if (!channel) return null;
  const status = getVoicePanelStatus(state);
  const location = [channel.nome, channel.servidorNome].filter(Boolean).join(' / ');
  const active = Boolean(state.compartilhandoTela);
  const pending = Boolean(state.compartilhamentoPendente);
  const canStart = status.id === 'connected' && state.podeCompartilharTela !== false
    && typeof actions.onIniciarTela === 'function' && !pending;
  const changeSource = actions.onTrocarFonte || actions.onIniciarTela;
  const errors = [...new Set([state.erro, state.erroCompartilhamento].filter(Boolean))];

  return <section className={`as-voice-panel as-voice-panel--${status.id}${active ? ' is-sharing' : ''}`} aria-label="Conexão de voz e transmissão">
    <div className="as-voice-panel__connection">
      <span className="as-voice-panel__signal"><VoicePanelIcon name="signal"/></span>
      <button type="button" className="as-voice-panel__location" onClick={actions.onAbrirChamada} disabled={typeof actions.onAbrirChamada !== 'function'} title={`Voltar à chamada: ${location}`} aria-label={`Voltar à chamada ${location}`}>
        <strong role="status" aria-live="polite">{status.label}</strong>
        <span>{location}</span>
      </button>
      <button type="button" className="as-voice-panel__disconnect" onClick={actions.onDesconectar} disabled={typeof actions.onDesconectar !== 'function'} title="Desconectar da chamada" aria-label="Desconectar da chamada"><VoicePanelIcon name="disconnect"/></button>
    </div>
    <div className="as-voice-panel__share-actions">
      {active ? <>
        <button type="button" className="as-voice-panel__share is-live" onClick={changeSource} disabled={status.id !== 'connected' || typeof changeSource !== 'function' || pending || state.podeCompartilharTela === false} title="Trocar fonte de compartilhamento" aria-label="Trocar fonte de compartilhamento">
          <VoicePanelIcon name="screen"/><span><strong>Ao vivo</strong><small>{pending ? 'Preparando…' : 'Trocar fonte'}</small></span>
        </button>
        <button type="button" className="as-voice-panel__stop" onClick={actions.onPararTela} disabled={typeof actions.onPararTela !== 'function'} title="Parar compartilhamento de tela" aria-label="Parar compartilhamento de tela"><VoicePanelIcon name="stop"/></button>
      </> : <button type="button" className="as-voice-panel__share" onClick={actions.onIniciarTela} disabled={!canStart} title={status.id === 'connected' ? 'Compartilhar tela' : 'Aguarde a conexão de voz para compartilhar'} aria-label="Compartilhar tela"><VoicePanelIcon name="screen"/><span>{pending ? 'Preparando transmissão…' : 'Compartilhar tela'}</span></button>}
    </div>
    {errors.map((error) => <p className="as-voice-panel__error" role="alert" key={error}>{error}</p>)}
  </section>;
}
