import React, { useEffect, useRef, useState } from 'react';
import { CallIcon } from './VoiceCallStage.jsx';
import VoiceStreamVideo from './VoiceStreamVideo.jsx';
import './VoiceStreamOverlays.css';

function clampPosition(x, y, player) {
  const inset = 12;
  const top = Math.min(52, Math.max(inset, window.innerHeight - player.offsetHeight - inset));
  return {
    x: Math.max(inset, Math.min(x, window.innerWidth - player.offsetWidth - inset)),
    y: Math.max(top, Math.min(y, window.innerHeight - player.offsetHeight - inset)),
  };
}

const arrowMovement = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };

export default function VoiceMiniPlayer({ stream, name, channel, local, muted, onMute, onRestore, onClose, position, setPosition }) {
  const playerRef = useRef(null);
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const resize = () => {
      const player = playerRef.current;
      if (player) setPosition((current) => current && clampPosition(current.x, current.y, player));
    };
    window.addEventListener('resize', resize);
    resize();
    return () => window.removeEventListener('resize', resize);
  }, [setPosition]);

  function startDrag(event) {
    if (event.button !== 0 || drag.current || event.target.closest('[data-mini-action]')) return;
    const rect = playerRef.current.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event) {
    if (drag.current?.id !== event.pointerId) return;
    setPosition(clampPosition(event.clientX - drag.current.x, event.clientY - drag.current.y, playerRef.current));
  }

  function finishDrag(event) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  }

  function moveWithKeyboard(event) {
    const movement = arrowMovement[event.key];
    if (!movement) return;
    event.preventDefault();
    const { left, top } = playerRef.current.getBoundingClientRect();
    setPosition(clampPosition(left + movement[0], top + movement[1], playerRef.current));
  }

  return (
    <section
      ref={playerRef} className={`voice-mini${dragging ? ' voice-mini--dragging' : ''}`}
      aria-label="Mini-player da transmissão"
      style={position ? { left: position.x, top: position.y, right: 'auto' } : undefined}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag}
      onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
    >
      <VoiceStreamVideo stream={stream} />
      <div className="voice-mini__top">
        <button type="button" className="voice-mini__move" aria-label="Mover mini-player com as setas"
          title="Arraste para mover" onKeyDown={moveWithKeyboard}><CallIcon name="grip" size={17} /></button>
        <span className="voice-mini__channel">{channel}</span>
        <span className="voice-live-badge">AO VIVO</span>
      </div>
      <div className="voice-mini__bottom">
        <strong>{name}</strong>
        <div className="voice-mini__actions">
          {!local && <button type="button" data-mini-action onClick={onMute} aria-label={muted ? 'Ativar áudio da transmissão' : 'Silenciar transmissão'} title={muted ? 'Ativar som' : 'Silenciar'}><CallIcon name={muted ? 'headphonesOff' : 'voice'} size={16} /></button>}
          <button type="button" data-mini-action onClick={onRestore} aria-label="Voltar para a transmissão" title="Voltar para a transmissão"><CallIcon name="expand" size={16} /></button>
          <button type="button" data-mini-action onClick={onClose} aria-label="Fechar mini-player" title="Fechar mini-player"><CallIcon name="close" size={16} /></button>
        </div>
      </div>
    </section>
  );
}
