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
  const peerSessionRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

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
          {role === 'viewer' && <button type="button" className="rooms-secondary-button" onClick={sair}>Sair da sala</button>}
        </div>
      </header>

      <section className="stream-stage" aria-label="Tela transmitida">
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
            <video ref={remoteVideoRef} autoPlay playsInline controls muted={remoteAudioMuted} />
            {remoteStream.getAudioTracks?.().length > 0 && (
              <button
                type="button"
                className="stream-audio-toggle"
                aria-pressed={!remoteAudioMuted}
                onClick={() => {
                  const nextMuted = !remoteAudioMuted;
                  setRemoteAudioMuted(nextMuted);
                  if (!nextMuted) remoteVideoRef.current?.play?.().catch(() => {});
                }}
              >
                {remoteAudioMuted ? 'Ativar áudio da tela' : 'Silenciar áudio da tela'}
              </button>
            )}
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
