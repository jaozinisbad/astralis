import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar.jsx';
import VoiceStreamVideo from './VoiceStreamVideo.jsx';
import './VoiceStreamOverlays.css';

export default function VoiceStreamPreview({ as: Anchor = 'div', stream, name, avatarUrl, avatarColor, onWatch, children, ...props }) {
  const [position, setPosition] = useState(null);
  const timer = useRef(null);
  const anchorRef = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return undefined;
    const dismiss = () => setPosition(null);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);

  function show(event) {
    if (!stream || event.pointerType === 'touch' || document.documentElement.dataset.streamerMode === 'true') return;
    clearTimeout(timer.current);
    const frame = anchorRef.current.getBoundingClientRect();
    const width = Math.min(276, window.innerWidth - 24);
    const preferredLeft = frame.right + width + 10 < window.innerWidth ? frame.right + 8 : frame.left - width - 8;
    setPosition({
      left: Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12)),
      top: Math.min(Math.max(12, frame.top), Math.max(12, window.innerHeight - width * 9 / 16 - 110)),
      width,
    });
  }

  function dismiss() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPosition(null), 150);
  }

  return <Anchor ref={anchorRef} {...props} onPointerEnter={show} onPointerLeave={dismiss} onFocus={show} onBlur={dismiss}
    onKeyDown={(event) => { if (event.key === 'Escape') setPosition(null); }}>
    {children}
    {stream && position && createPortal(
      <aside className="voice-stream-preview" aria-label={`Prévia de ${name}`} style={position}
        onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={dismiss}
        onFocus={() => clearTimeout(timer.current)} onBlur={dismiss}>
        <div className="voice-stream-preview__header"><Avatar nome={name} avatarUrl={avatarUrl} avatarCor={avatarColor} tamanho="sm" /><strong>{name}</strong><span className="voice-live-badge">AO VIVO</span></div>
        <div className="voice-stream-preview__video"><VoiceStreamVideo stream={stream} /></div>
        <button type="button" onClick={() => { setPosition(null); onWatch(); }}>Abrir transmissão</button>
      </aside>,
      document.body,
    )}
  </Anchor>;
}
