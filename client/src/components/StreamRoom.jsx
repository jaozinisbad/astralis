import React, { useEffect, useRef, useState } from 'react';
import { createStreamRoomPeerSession } from '../streamRoomPeer.mjs';
import { parseYouTubeVideoId } from '../youtubeVideoId.mjs';
import StreamRoomActionBar from './StreamRoomActionBar.jsx';
import YouTubeRoomPlayer from './YouTubeRoomPlayer.jsx';

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

function salaComPresenter(resposta) {
  if (!resposta?.room) return resposta?.room || null;
  return {
    ...resposta.room,
    presenterSocketId: resposta.presenterSocketId ?? resposta.room.presenterSocketId ?? null,
    presenterName: resposta.presenterName ?? resposta.room.presenterName ?? null,
  };
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
  onOpenSettings = () => {},
  onExit = () => {},
}) {
  const [room, setRoom] = useState(initialRoom);
  const [youtubeSource, setYoutubeSource] = useState(initialRoom?.youtubeSource || null);
  const [youtubePlayback, setYoutubePlayback] = useState(initialRoom?.youtubePlayback || null);
  const [youtubeDialogOpen, setYoutubeDialogOpen] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const peerRole = room?.presenterSocketId === socket?.id ? 'host' : 'viewer';
  const [remoteStream, setRemoteStream] = useState(null);
  const [joined, setJoined] = useState(Boolean(joinedInitially));
  const [joining, setJoining] = useState(role === 'viewer' && !joinedInitially);
  const [code, setCode] = useState(initialAccessCode);
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [roomClosed, setRoomClosed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [remoteAudioMuted, setRemoteAudioMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [volumeSupported, setVolumeSupported] = useState(null);
  const [playbackNeedsGesture, setPlaybackNeedsGesture] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const peerSessionRef = useRef(null);
  const presenterPeerIdsRef = useRef([]);
  const requestedStreamRef = useRef(null);
  const joinedRef = useRef(Boolean(joinedInitially));
  const reconnectRequiredRef = useRef(false);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const stageRef = useRef(null);
  const hadRemoteStreamRef = useRef(false);

  useEffect(() => {
    if (!socket || !roomId || !role) return undefined;
    const peerSession = createStreamRoomPeerSession({
      socket,
      roomId,
      role: peerRole,
      quality,
      onRemoteStream: (_peerId, stream) => setRemoteStream(stream),
      onQualityError: () => setError('O navegador não aceitou o limite de bitrate. A transmissão continuará, mas pode ficar abaixo do perfil selecionado.'),
      onPeerConnectionFailed: () => {
        if (joinedRef.current && socket.connected !== false) {
          socket.emit('sala:espectador-pronto', { roomId });
        }
      },
    });
    peerSessionRef.current = peerSession;
    peerSession.setLocalStream(localStream);
    peerSession.setViewers(presenterPeerIdsRef.current);

    const onClosed = (message = {}) => {
      if (message.salaId === roomId) setRoomClosed(true);
    };
    const onRoomState = (message = {}) => {
      if (message.sala?.id !== roomId) return;
      setRoom((current) => {
        const sameLiveState = Boolean(current?.isLive) === Boolean(message.sala.isLive);
        const hasPresenterId = Object.prototype.hasOwnProperty.call(message.sala, 'presenterSocketId');
        const hasPresenterName = Object.prototype.hasOwnProperty.call(message.sala, 'presenterName');
        return {
          ...message.sala,
          presenterSocketId: hasPresenterId ? message.sala.presenterSocketId : sameLiveState ? current?.presenterSocketId || null : null,
          presenterName: hasPresenterName ? message.sala.presenterName : sameLiveState ? current?.presenterName || null : null,
        };
      });
    };
    const onTransmission = (message = {}) => {
      if (message.salaId !== roomId) return;
      setRoom((current) => current ? {
        ...current,
        isLive: Boolean(message.isLive),
        presenterSocketId: message.presenterSocketId || null,
        presenterName: message.presenterName || null,
      } : current);
      if (!message.isLive) {
        presenterPeerIdsRef.current = [];
        peerSessionRef.current?.resetPeers();
      }
    };
    const onYouTubeState = (message = {}) => {
      if (message.salaId !== roomId) return;
      setYoutubeSource(message.source || null);
      setYoutubePlayback(message.playback || null);
    };
    const onYouTubePlayback = (message = {}) => {
      if (message.salaId !== roomId) return;
      setYoutubePlayback(message.playback || null);
    };
    socket.on('sala:encerrada', onClosed);
    socket.on('sala:estado', onRoomState);
    socket.on('sala:transmissao', onTransmission);
    socket.on('sala:youtube:estado', onYouTubeState);
    socket.on('sala:youtube:reproducao', onYouTubePlayback);

    return () => {
      socket.off('sala:encerrada', onClosed);
      socket.off('sala:estado', onRoomState);
      socket.off('sala:transmissao', onTransmission);
      socket.off('sala:youtube:estado', onYouTubeState);
      socket.off('sala:youtube:reproducao', onYouTubePlayback);
      peerSession.close();
      peerSessionRef.current = null;
    };
  }, [socket, roomId, peerRole]);

  useEffect(() => {
    if (role !== 'viewer' || joinedInitially) return;
    setJoined(false);
    setJoining(true);
    entrar(initialAccessCode);
  }, [socket, roomId, role, joinedInitially]);

  useEffect(() => {
    if (!socket || !roomId) return undefined;
    const onDisconnect = () => {
      if (!joinedRef.current) return;
      reconnectRequiredRef.current = true;
      joinedRef.current = false;
      requestedStreamRef.current = null;
      presenterPeerIdsRef.current = [];
      peerSessionRef.current?.resetPeers();
      setJoined(false);
      setReconnecting(true);
      setRoom((current) => current?.presenterSocketId === socket.id
        ? { ...current, isLive: false, presenterSocketId: null, presenterName: null }
        : current);
    };
    const onConnect = async () => {
      if (!reconnectRequiredRef.current) return;
      const rejoined = await entrar(code);
      if (socket.connected === false) return;
      if (rejoined) {
        reconnectRequiredRef.current = false;
        setReconnecting(false);
        setError('');
        return;
      }
      reconnectRequiredRef.current = false;
      setReconnecting(false);
      setRoomClosed(true);
      if (localStream) await onStopShare();
    };
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [socket, roomId, initialAccessCode, code, localStream, onStopShare]);

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
    if (!socket || !joined || !roomId || reconnecting || socket.connected === false) return;
    if (localStream) {
      if (requestedStreamRef.current === localStream || room?.presenterSocketId === socket.id) return;
      requestedStreamRef.current = localStream;
      emitir(socket, 'salas:ao-vivo', { roomId, isLive: true }).then((resposta) => {
        if (!resposta.ok) {
          requestedStreamRef.current = null;
          setError(resposta.error || 'Não foi possível iniciar a transmissão.');
          onStopShare();
          return;
        }
        presenterPeerIdsRef.current = resposta.peerSocketIds || [];
        setRoom(salaComPresenter(resposta));
        peerSessionRef.current?.setViewers(presenterPeerIdsRef.current);
      });
      return;
    }
    if (!requestedStreamRef.current) return;
    requestedStreamRef.current = null;
    presenterPeerIdsRef.current = [];
    emitir(socket, 'salas:ao-vivo', { roomId, isLive: false }).then((resposta) => {
      if (resposta.ok) setRoom(salaComPresenter(resposta));
      else if (!roomClosed) setError(resposta.error || 'Não foi possível encerrar a transmissão.');
    });
  }, [socket, joined, reconnecting, roomId, localStream, room?.presenterSocketId, onStopShare, roomClosed]);

  useEffect(() => {
    if (!socket || !joined || !roomId || reconnecting || !room?.isLive
      || !room.presenterSocketId || peerRole !== 'viewer') return;
    socket.emit('sala:espectador-pronto', { roomId });
  }, [socket, joined, reconnecting, roomId, room?.isLive, room?.presenterSocketId, peerRole]);

  async function entrar(codigo = code) {
    if (!socket) return false;
    setJoining(true);
    setError('');
    const resposta = await emitir(socket, 'salas:entrar', { roomId, accessCode: codigo.trim() });
    setJoining(false);
    if (!resposta.ok) {
      setError(resposta.error || 'Não foi possível entrar nesta sala.');
      if (/código|privada/i.test(resposta.error || '')) setNeedsCode(true);
      return false;
    }
    setRoom(salaComPresenter(resposta));
    setYoutubeSource(resposta.youtubeSource || null);
    setYoutubePlayback(resposta.youtubePlayback || null);
    presenterPeerIdsRef.current = resposta.peerSocketIds || [];
    joinedRef.current = true;
    setJoined(true);
    setNeedsCode(false);
    return true;
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
    if (localStream) await onStopShare();
    if (role === 'host') {
      await emitir(socket, 'salas:encerrar', { roomId });
    } else if (joined) {
      await emitir(socket, 'salas:sair', {});
    }
    onExit();
  }

  async function pararTransmissao() {
    if (localStream) {
      await onStopShare();
      return;
    }
    const resposta = await emitir(socket, 'salas:ao-vivo', { roomId, isLive: false });
    if (resposta.ok) setRoom(salaComPresenter(resposta));
    else setError(resposta.error || 'Não foi possível encerrar a transmissão.');
  }

  function abrirFonteYouTube() {
    if (role !== 'host') {
      setError('Somente o anfitrião pode adicionar ou trocar a fonte do YouTube.');
      return;
    }
    if (room?.isLive) {
      setError('Pare a transmissão de tela antes de adicionar uma fonte do YouTube.');
      return;
    }
    setError('');
    setYoutubeUrl('');
    setYoutubeDialogOpen(true);
  }

  async function salvarFonteYouTube(event) {
    event.preventDefault();
    const videoId = parseYouTubeVideoId(youtubeUrl);
    if (!videoId) {
      setError('Cole um link válido de um vídeo do YouTube.');
      return;
    }
    const resposta = await emitir(socket, 'sala:youtube:fonte', { roomId, videoId });
    if (!resposta.ok) {
      setError(resposta.error || 'Não foi possível adicionar o vídeo do YouTube.');
      return;
    }
    setYoutubeSource(resposta.source || { videoId });
    setYoutubePlayback(resposta.playback || { action: 'pause', currentTime: 0, revision: 0 });
    setYoutubeDialogOpen(false);
    setYoutubeUrl('');
    setError('');
  }

  async function removerFonteYouTube() {
    const resposta = await emitir(socket, 'sala:youtube:fonte', { roomId, videoId: null });
    if (!resposta.ok) {
      setError(resposta.error || 'Não foi possível remover a fonte do YouTube.');
      return;
    }
    setYoutubeSource(null);
    setYoutubePlayback(null);
    setYoutubeDialogOpen(false);
    setYoutubeUrl('');
  }

  async function enviarComandoYouTube(action, currentTime) {
    const resposta = await emitir(socket, 'sala:youtube:reproducao', { roomId, action, currentTime });
    if (!resposta.ok) {
      setError(resposta.error || 'Não foi possível sincronizar o vídeo.');
      return;
    }
    if (resposta.playback) setYoutubePlayback(resposta.playback);
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
      const video = remoteVideoRef.current;
      if (video?.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === 'function') {
        video.webkitExitFullscreen();
        return;
      }
      if (typeof video?.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen();
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

  const isRoomOwner = role === 'host';
  const isCurrentPresenter = room?.presenterSocketId === socket?.id;
  const occupiedByAnother = Boolean(room?.isLive && !isCurrentPresenter);
  const hasActiveYoutubeSource = Boolean(youtubeSource?.videoId);
  const presenterIsSeparateParticipant = Boolean(room?.presenterName && room.presenterName !== room.ownerName);
  const currentViewerIsSeparateParticipant = role === 'viewer' && !isCurrentPresenter;
  const unlistedViewerCount = Math.max(0, Number(room?.viewerCount || 0)
    - Number(presenterIsSeparateParticipant) - Number(currentViewerIsSeparateParticipant));

  if (role === 'viewer' && !joined && !roomClosed && !reconnecting) {
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
            <p className="rooms-eyebrow">{isRoomOwner ? 'SUA SALA' : 'SALA DE TRANSMISSÃO'}</p>
            <h1>{room?.name || initialRoom?.name || 'Sala Astralis'}</h1>
          </div>
          <span className={`stream-live-pill${localStream || room?.isLive || hasActiveYoutubeSource ? ' is-live' : ''}`}>
            <span />{localStream || room?.isLive ? 'AO VIVO' : hasActiveYoutubeSource ? 'VÍDEO DO YOUTUBE' : 'AGUARDANDO TRANSMISSÃO'}
          </span>
        </div>
        <div className="stream-room-actions">
          {isRoomOwner && room?.visibility === 'private' && <span className="stream-room-code">Código: <strong>{initialAccessCode}</strong></span>}
          {isRoomOwner && <button type="button" className="rooms-secondary-button" onClick={copiarLink}>{copied ? 'Link copiado' : 'Copiar link'}</button>}
          {localStream || isCurrentPresenter
            ? <button type="button" className="rooms-danger-button" disabled={reconnecting} onClick={pararTransmissao}>Parar transmissão</button>
            : <button type="button" className="rooms-primary-button" disabled={occupiedByAnother || reconnecting} title={occupiedByAnother ? 'A sala permite uma transmissão por vez.' : undefined} onClick={onRequestShare}>{reconnecting ? 'Reconectando…' : occupiedByAnother ? 'Outra pessoa está transmitindo' : 'Compartilhar tela'}</button>}
        </div>
      </header>

      <div className="stream-room-workspace">
        <section ref={stageRef} className={`stream-stage${pseudoFullscreen ? ' is-pseudo-fullscreen' : ''}`} aria-label="Tela transmitida">
          {localStream ? <video ref={localVideoRef} autoPlay muted playsInline /> : remoteStream ? (
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
          ) : youtubeSource?.videoId ? (
            <YouTubeRoomPlayer
              videoId={youtubeSource.videoId}
              playback={youtubePlayback}
              onPlaybackCommand={enviarComandoYouTube}
            />
          ) : (
            <div className="stream-stage-empty" role="status" aria-live="polite">
              {room?.isLive
                ? <div className="stream-stage-empty__spinner" aria-hidden="true" />
                : <div className="stream-stage-empty__icon" aria-hidden="true">◉</div>}
              <h2>{room?.isLive ? 'Conectando à transmissão…' : 'Ninguém está transmitindo ainda'}</h2>
              <p>{room?.isLive
                ? `Transmitido por ${room?.presenterName || room?.ownerName || 'um participante da sala'}.`
                : 'Seja a primeira pessoa a compartilhar sua tela com a sala.'}</p>
              {!room?.isLive && <div className="stream-stage-empty__actions">
                <button type="button" className="rooms-primary-button" disabled={reconnecting} onClick={onRequestShare}>{reconnecting ? 'Reconectando…' : 'Compartilhar tela'}</button>
                {isRoomOwner && <button type="button" className="rooms-secondary-button" onClick={abrirFonteYouTube}>Adicionar fonte de vídeo</button>}
              </div>}
            </div>
          )}
          {youtubeSource?.videoId && isRoomOwner && <button type="button" className="stream-source-remove" onClick={removerFonteYouTube}>Remover vídeo da sala</button>}
        </section>

        <aside className="stream-room-participants" aria-label="Participantes da sala">
          <header className="stream-room-participants__header">
            <h2>Participantes</h2>
            <span>{Math.max(1, Number(room?.viewerCount || 0) + 1)}</span>
          </header>
          <ul className="stream-room-participants__list">
            <li>
              <span className="stream-room-participants__avatar" aria-hidden="true">{(room?.ownerName || 'A').trim().slice(0, 1).toUpperCase()}</span>
              <span className="stream-room-participants__identity"><strong>{room?.ownerName || (isRoomOwner ? 'Você' : 'Anfitrião')}</strong><small>Anfitrião</small></span>
              <span className="stream-room-participants__online" aria-label="online" />
            </li>
            {presenterIsSeparateParticipant && <li>
              <span className="stream-room-participants__avatar stream-room-participants__avatar--live" aria-hidden="true">{room.presenterName.trim().slice(0, 1).toUpperCase()}</span>
              <span className="stream-room-participants__identity"><strong>{room.presenterName}</strong><small>Transmitindo agora</small></span>
              <span className="stream-room-participants__online stream-room-participants__online--live" aria-label="transmitindo" />
            </li>}
            {currentViewerIsSeparateParticipant && <li>
              <span className="stream-room-participants__avatar stream-room-participants__avatar--quiet" aria-hidden="true">V</span>
              <span className="stream-room-participants__identity"><strong>Você</strong><small>Na sala</small></span>
              <span className="stream-room-participants__online" aria-label="online" />
            </li>}
            {unlistedViewerCount > 0 && <li className="stream-room-participants__summary">
              <span className="stream-room-participants__avatar stream-room-participants__avatar--quiet" aria-hidden="true">+</span>
              <span className="stream-room-participants__identity"><strong>Mais {unlistedViewerCount} {unlistedViewerCount === 1 ? 'espectador' : 'espectadores'}</strong><small>na sala</small></span>
            </li>}
          </ul>
          <p className="stream-room-participants__note">Compartilhamento de tela e vídeo do YouTube. Para conversar, usem o Discord.</p>
        </aside>
      </div>

      <StreamRoomActionBar
        isSharing={Boolean(localStream || isCurrentPresenter)}
        hasYouTubeSource={hasActiveYoutubeSource}
        canManageSource={isRoomOwner}
        shareDisabled={occupiedByAnother || hasActiveYoutubeSource}
        sourceDisabled={Boolean(room?.isLive)}
        disabled={reconnecting}
        onShare={onRequestShare}
        onStopShare={pararTransmissao}
        onAddYouTube={abrirFonteYouTube}
        onSettings={onOpenSettings}
        onFullscreen={alternarTelaCheia}
        onExit={sair}
        exitLabel={isRoomOwner ? 'Encerrar sala' : 'Parar de assistir'}
      />
      {youtubeDialogOpen && <div className="stream-youtube-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setYoutubeDialogOpen(false); }}>
        <section className="stream-youtube-dialog" role="dialog" aria-modal="true" aria-labelledby="stream-youtube-title">
          <button type="button" className="stream-youtube-dialog__close" aria-label="Fechar" onClick={() => setYoutubeDialogOpen(false)}>×</button>
          <p className="rooms-eyebrow">FONTE COMPARTILHADA</p>
          <h2 id="stream-youtube-title">Adicionar vídeo do YouTube</h2>
          <p>Cada pessoa assiste ao vídeo diretamente do YouTube; os controles ficam sincronizados. Vamos iniciar ao adicionar, mas o celular pode exigir um toque.</p>
          <form onSubmit={salvarFonteYouTube}>
            <label htmlFor="stream-youtube-url">Link do vídeo</label>
            <input id="stream-youtube-url" type="text" inputMode="url" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" autoComplete="url" required />
            {error && <p className="rooms-error" role="alert">{error}</p>}
            <div className="stream-youtube-dialog__actions">
              {youtubeSource && <button type="button" className="rooms-danger-button" onClick={removerFonteYouTube}>Remover vídeo</button>}
              <button type="button" className="rooms-secondary-button" onClick={() => setYoutubeDialogOpen(false)}>Cancelar</button>
              <button type="submit" className="rooms-primary-button">{youtubeSource ? 'Trocar vídeo' : 'Adicionar vídeo'}</button>
            </div>
          </form>
        </section>
      </div>}
      {reconnecting && <p className="rooms-toast" role="status">Reconectando à sala e restaurando a transmissão…</p>}
      {error && !youtubeDialogOpen && <p className="rooms-toast" role="alert">{error}</p>}
    </main>
  );
}
