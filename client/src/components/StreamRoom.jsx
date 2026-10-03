import React, { useEffect, useRef, useState } from 'react';
import { createStreamRoomPeerSession } from '../streamRoomPeer.mjs';

const EMPTY_QUALITY = Object.freeze({});

function emitir(socket, evento, dados) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'O servidor demorou para responder. Confira sua conexão e tente novamente.' }), 20_000);
    socket.emit(evento, dados, (resposta) => {
      clearTimeout(timer);
      resolve(resposta || { ok: false, error: 'O servidor não respondeu.' });
    });
  });
}

export default function StreamRoom({
  socket,
  roomId,
  role,
  room: initialRoom = null,
  accessCode: initialAccessCode = '',
  joinedInitially = false,
  localStream = null,
  quality = EMPTY_QUALITY,
  onRequestShare = () => {},
  onStopShare = () => {},
  onExit = () => {},
}) {
  const [room, setRoom] = useState(initialRoom);
  const [remoteStream, setRemoteStream] = useState(null);
  const [joined, setJoined] = useState(role === 'host' && joinedInitially);
  const [joining, setJoining] = useState(role === 'viewer' && !joinedInitially);
  const [code, setCode] = useState(initialAccessCode);
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [roomClosed, setRoomClosed] = useState(false);
  const [remoteAudioMuted, setRemoteAudioMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [volumeSupported, setVolumeSupported] = useState(null);
  const [playbackNeedsGesture, setPlaybackNeedsGesture] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const peerSessionRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const stageRef = useRef(null);
  const hadRemoteStreamRef = useRef(false);

  useEffect(() => {
    if (!socket || !roomId || !role) return undefined;
    const peerSession = createStreamRoomPeerSession({
      socket,
      roomId,
      role,
      quality,
      onRemoteStream: (_peerId, stream) => setRemoteStream(stream),
    });
    peerSessionRef.current = peerSession;
    peerSession.setLocalStream(localStream);

    const onClosed = (message = {}) => {
      if (message.salaId === roomId) setRoomClosed(true);
    };
    const onRoomState = (message = {}) => {
      if (message.sala?.id === roomId) setRoom(message.sala);
    };
    socket.on('sala:encerrada', onClosed);
    socket.on('sala:estado', onRoomState);

    return () => {
      socket.off('sala:encerrada', onClosed);
      socket.off('sala:estado', onRoomState);
      peerSession.close();
      peerSessionRef.current = null;
    };
  }, [socket, roomId, role]);

  useEffect(() => {
    if (role !== 'viewer' || joinedInitially) return;
    setJoined(false);
    setJoining(true);
    entrar(initialAccessCode);
  }, [socket, roomId, role, joinedInitially]);

  useEffect(() => {
    peerSessionRef.current?.setLocalStream(localStream);
  }, [localStream]);

  useEffect(() => {
    peerSessionRef.current?.setQuality(quality);
  }, [quality]);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream || null;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream || null;
  }, [remoteStream]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video || !remoteStream) return;
    try {
      const originalVolume = video.volume;
      const probeVolume = originalVolume === 0.5 ? 0.25 : 0.5;
      video.volume = probeVolume;
      const supported = Math.abs(video.volume - probeVolume) < 0.01;
      video.volume = originalVolume;
      setVolumeSupported(supported);
    } catch {
      setVolumeSupported(false);
    }
    try { Promise.resolve(video.play?.()).catch(() => setPlaybackNeedsGesture(true)); }
    catch { setPlaybackNeedsGesture(true); }
  }, [remoteStream]);

  useEffect(() => {
    if (!remoteVideoRef.current) return;
    if (volumeSupported) {
      try { remoteVideoRef.current.volume = volume; }
      catch { setVolumeSupported(false); }
    }
    remoteVideoRef.current.muted = remoteAudioMuted;
  }, [remoteStream, volume, volumeSupported, remoteAudioMuted]);

  useEffect(() => {
    if (!pseudoFullscreen || typeof document === 'undefined' || !document.body) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [pseudoFullscreen]);

  useEffect(() => {
    if (remoteStream) {
      hadRemoteStreamRef.current = true;
      return;
    }
    if (!hadRemoteStreamRef.current) return;
    hadRemoteStreamRef.current = false;
    setPseudoFullscreen(false);
    if (typeof document !== 'undefined' && document.fullscreenElement === stageRef.current) {
      Promise.resolve(document.exitFullscreen?.()).catch(() => setError('Use o controle de tela cheia do navegador para sair.'));
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!socket || role !== 'host' || !joined || !roomId) return;
    emitir(socket, 'salas:ao-vivo', { roomId, isLive: Boolean(localStream) }).then((resposta) => {
      if (!resposta.ok) setError(resposta.error || 'Não foi possível atualizar a transmissão.');
    });
  }, [socket, role, joined, roomId, localStream]);

  async function entrar(codigo = code) {
    if (!socket) return;
    setJoining(true);
    setError('');
    const resposta = await emitir(socket, 'salas:entrar', { roomId, accessCode: codigo.trim() });
    setJoining(false);
    if (!resposta.ok) {
      setError(resposta.error || 'Não foi possível entrar nesta sala.');
      if (/código|privada/i.test(resposta.error || '')) setNeedsCode(true);
      return;
    }
    setRoom(resposta.room);
    setJoined(true);
    setNeedsCode(false);
  }

  async function copiarLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('room', roomId);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Não consegui copiar automaticamente. Copie o endereço desta sala pelo navegador.');
    }
  }

  async function sair() {
    if (role === 'host') {
      await onStopShare();
      await emitir(socket, 'salas:encerrar', { roomId });
    } else if (joined) {
      await emitir(socket, 'salas:sair', {});
    }
    onExit();
  }

  function ajustarVolume(event) {
    const nextVolume = Math.min(1, Math.max(0, Number(event.target.value) / 100));
    setVolume(nextVolume);
    setRemoteAudioMuted(nextVolume === 0);
    if (nextVolume > 0) Promise.resolve(remoteVideoRef.current?.play?.()).catch(() => {});
  }

  function alternarAudio() {
    if (remoteAudioMuted && volume === 0) setVolume(1);
    setRemoteAudioMuted(!remoteAudioMuted);
    if (remoteAudioMuted) Promise.resolve(remoteVideoRef.current?.play?.()).catch(() => {});
  }

  async function iniciarVideo() {
    try {
      await remoteVideoRef.current?.play?.();
      setPlaybackNeedsGesture(false);
    } catch {
      setPlaybackNeedsGesture(true);
      setError('Toque novamente para iniciar o vídeo neste navegador.');
    }
  }

  async function alternarJanelaFlutuante() {
    const video = remoteVideoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
        video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else setError('Janela flutuante não está disponível neste navegador.');
    } catch {
      setError('Não foi possível abrir a janela flutuante neste navegador.');
    }
  }

  async function alternarTelaCheia() {
    try {
      if (pseudoFullscreen) {
        setPseudoFullscreen(false);
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageRef.current?.requestFullscreen) {
        try { await stageRef.current.requestFullscreen(); }
        catch { setPseudoFullscreen(true); }
      } else setPseudoFullscreen(true);
    } catch {
      setError('Não foi possível abrir a tela cheia neste navegador.');
    }
  }

  if (role === 'viewer' && !joined && !roomClosed) {
    return (
      <main className="stream-room-gate">
        <button type="button" className="rooms-back-button" onClick={onExit}>← Salas</button>
        <div className="stream-room-gate__card">
          <img src="./astralis-mark.svg" alt="" />
          <p className="rooms-eyebrow">ASTRALIS · ASSISTIR</p>
          <h1>{joining ? 'Entrando na sala…' : 'A sala está protegida'}</h1>
          <p>Você assiste pelo navegador. Para conversar, use seu Discord.</p>
          {needsCode && (
            <form onSubmit={(event) => { event.preventDefault(); entrar(); }}>
              <label htmlFor="stream-room-code">Código de acesso</label>
              <input id="stream-room-code" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} maxLength={32} />
              <button type="submit" disabled={joining || !code.trim()}>Entrar na sala</button>
            </form>
          )}
          {error && <p className="rooms-error" role="alert">{error}</p>}
          {!joining && !needsCode && !error && <button type="button" onClick={() => entrar()}>Tentar entrar</button>}
        </div>
      </main>
    );
  }

  if (roomClosed) {
    return (
      <main className="stream-room-gate">
        <div className="stream-room-gate__card">
          <p className="rooms-eyebrow">ASTRALIS · SALA ENCERRADA</p>
          <h1>Esta transmissão terminou</h1>
          <button type="button" onClick={onExit}>Voltar às salas</button>
        </div>
      </main>
    );
  }

  return (
    <main className="stream-room-view">
      <header className="stream-room-header">
        <div className="stream-room-heading">
          <button type="button" className="rooms-back-button" onClick={sair}>← Salas</button>
          <div>
            <p className="rooms-eyebrow">{role === 'host' ? 'SUA SALA' : 'ASSISTINDO AGORA'}</p>
            <h1>{room?.name || initialRoom?.name || 'Sala Astralis'}</h1>
          </div>
          <span className={`stream-live-pill${localStream || room?.isLive ? ' is-live' : ''}`}>
            <span />{localStream || room?.isLive ? 'AO VIVO' : 'AGUARDANDO TRANSMISSÃO'}
          </span>
        </div>
        <div className="stream-room-actions">
          {role === 'host' && room?.visibility === 'private' && <span className="stream-room-code">Código: <strong>{initialAccessCode}</strong></span>}
          {role === 'host' && <button type="button" className="rooms-secondary-button" onClick={copiarLink}>{copied ? 'Link copiado' : 'Copiar link'}</button>}
          {role === 'host' && (localStream
            ? <button type="button" className="rooms-danger-button" onClick={onStopShare}>Parar transmissão</button>
            : <button type="button" className="rooms-primary-button" onClick={onRequestShare}>Compartilhar tela</button>)}
        </div>
      </header>

      <section ref={stageRef} className={`stream-stage${pseudoFullscreen ? ' is-pseudo-fullscreen' : ''}`} aria-label="Tela transmitida">
        {role === 'host' ? (
          localStream ? <video ref={localVideoRef} autoPlay muted playsInline /> : (
            <div className="stream-stage-empty">
              <div className="stream-stage-empty__icon" aria-hidden="true">◉</div>
              <h2>Pronto para compartilhar?</h2>
              <p>A tela aparece aqui. O áudio e a conversa do Discord não entram na sala.</p>
              <button type="button" className="rooms-primary-button" onClick={onRequestShare}>Escolher tela</button>
            </div>
          )
        ) : remoteStream ? (
          <>
            <video ref={remoteVideoRef} autoPlay playsInline muted={remoteAudioMuted} onPause={() => setPlaybackNeedsGesture(true)} onPlaying={() => setPlaybackNeedsGesture(false)} />
            {playbackNeedsGesture && <button type="button" className="stream-player-start" onClick={iniciarVideo}>Iniciar vídeo</button>}
            <div className="stream-player-controls" role="group" aria-label="Controles da transmissão">
              {volumeSupported === true && <input type="range" className="stream-player-volume" min="0" max="100" value={Math.round(volume * 100)} onChange={ajustarVolume} aria-label="Volume da transmissão" />}
              <button type="button" className="stream-player-button" aria-label="Silenciar áudio" aria-pressed={remoteAudioMuted} title={remoteAudioMuted ? 'Ativar áudio' : 'Silenciar áudio'} onClick={alternarAudio}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d={remoteAudioMuted || volume === 0 ? 'M17 9l5 6m0-6-5 6' : 'M16 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12'} /></svg>
              </button>
              <button type="button" className="stream-player-button" aria-label="Picture-in-picture" title="Janela flutuante" onClick={alternarJanelaFlutuante}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 12h7v5h-7z" /></svg>
              </button>
              <button type="button" className="stream-player-button" aria-label="Tela cheia" title="Tela cheia" onClick={alternarTelaCheia}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" /></svg>
              </button>
              <button type="button" className="stream-player-button stream-player-button--exit" aria-label="Parar de assistir" title="Parar de assistir" onClick={sair}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10 5.3a10.6 10.6 0 0 1 11 6.7 10.8 10.8 0 0 1-3.1 4.2M6.2 6.3A11 11 0 0 0 3 12c2.2 4.1 5.2 6 9 6 1.1 0 2.1-.2 3-.5" /><path d="M9.8 9.8a3.1 3.1 0 0 0 4.4 4.4" /></svg>
              </button>
            </div>
          </>
        ) : (
          <div className="stream-stage-empty" role="status" aria-live="polite">
            <div className="stream-stage-empty__spinner" aria-hidden="true" />
            <h2>Conectando à transmissão…</h2>
            <p>Se demorar, confira se o anfitrião iniciou o compartilhamento.</p>
          </div>
        )}
      </section>

      <footer className="stream-room-footer">
        <span>{role === 'host' ? 'Você é o anfitrião' : `Transmitido por ${room?.ownerName || 'Anfitrião'}`}</span>
        <span>{room?.viewerCount || 0} {room?.viewerCount === 1 ? 'espectador' : 'espectadores'}</span>
        <span className="stream-room-discord-note">Sem voz ou chat · continuem pelo Discord</span>
      </footer>
      {error && <p className="rooms-toast" role="alert">{error}</p>}
    </main>
  );
}
