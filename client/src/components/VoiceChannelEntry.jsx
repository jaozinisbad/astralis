import React from 'react';
import Avatar from './Avatar.jsx';
import './VoiceCallStage.css';

export default function VoiceChannelEntry({ canal, participantes = [], onEntrar }) {
  return <section className="content voice-stage voice-entry" aria-label={`Canal de voz ${canal.nome}`}>
    <header className="voice-stage__header"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4V5ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/></svg><h1>{canal.nome}</h1></header>
    <div className="voice-entry__body"><img src="./astralis-mark.svg" alt=""/><h2>{canal.nome}</h2><p>{participantes.length ? `${participantes.length} ${participantes.length === 1 ? 'pessoa na chamada' : 'pessoas na chamada'}` : 'Conecte-se à voz para conversar e compartilhar sua tela.'}</p>
      {participantes.length > 0 && <div className="voice-entry__people">{participantes.map((p) => <Avatar key={p.socketId} nome={p.nome} avatarCor={p.avatarCor} avatarUrl={p.avatarUrl} tamanho="md"/>)}</div>}
      <button type="button" className="voice-entry__join" onClick={onEntrar}>Conectar à voz</button>
    </div>
  </section>;
}
