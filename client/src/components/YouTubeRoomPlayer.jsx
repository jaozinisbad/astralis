import React, { useEffect, useRef, useState } from 'react';
import { isYouTubeVideoId } from '../youtubeVideoId.mjs';
import './YouTubeRoomPlayer.css';

const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
let iframeApiPromise;

function loadYouTubeIframeApi() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('O player do YouTube só pode ser carregado no navegador.'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise((resolve, reject) => {
    const previousReadyCallback = window.onYouTubeIframeAPIReady;
    const onReady = () => {
      try {
        previousReadyCallback?.();
      } catch {
        // A different embed on the page must not prevent this player from loading.
      } finally {
        if (window.YT?.Player) resolve(window.YT);
        else reject(new Error('A API do YouTube não ficou disponível.'));
      }
    };
    window.onYouTubeIframeAPIReady = onReady;

    let script = [...document.scripts].find((candidate) => candidate.src === IFRAME_API_URL);
    if (!script) {
      script = document.createElement('script');
      script.src = IFRAME_API_URL;
      script.async = true;
      document.head.appendChild(script);
    }

    script.addEventListener('error', () => {
      iframeApiPromise = null;
      window.onYouTubeIframeAPIReady = previousReadyCallback;
      reject(new Error('Não foi possível carregar a API do YouTube.'));
    }, { once: true });
  });

  return iframeApiPromise;
}

function finiteTime(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampToDuration(value, totalDuration) {
  const time = finiteTime(value);
  return Number.isFinite(totalDuration) && totalDuration > 0
    ? Math.min(time, totalDuration)
    : time;
}

export function getPlaybackAgeSeconds(updatedAt, now = Date.now()) {
  if (!Number.isFinite(now)) return 0;

  let timestamp = Number.NaN;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    timestamp = updatedAt;
  } else if (
    typeof updatedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(updatedAt)
  ) {
    timestamp = Date.parse(updatedAt);
  }

  if (!Number.isFinite(timestamp)) return 0;
  const elapsedSeconds = (now - timestamp) / 1000;
  // A play state can remain unchanged for a long movie; preserve its clock for
  // late joiners while still rejecting implausibly old timestamps.
  return elapsedSeconds >= 0 && elapsedSeconds <= 86400 ? elapsedSeconds : 0;
}

function formatTime(seconds) {
  const total = Math.floor(finiteTime(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function getEmbedErrorMessage(code) {
  if (code === 100) return 'Este vídeo foi removido, está privado ou não está disponível.';
  if (code === 101 || code === 150) return 'O proprietário não permite reproduzir este vídeo em outros sites.';
  if (code === 153) return 'O YouTube não conseguiu identificar este site para reproduzir o vídeo.';
  return 'Não foi possível reproduzir este vídeo do YouTube.';
}

export default function YouTubeRoomPlayer({
  videoId,
  playback = null,
  onPlaybackCommand = () => {},
}) {
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const timerRef = useRef(null);
  const playbackRef = useRef(playback);
  const commandCallbackRef = useRef(onPlaybackCommand);
  const lastAppliedRevisionRef = useRef(-1);
  const [status, setStatus] = useState(isYouTubeVideoId(videoId) ? 'loading' : 'invalid');
  const [playerState, setPlayerState] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  playbackRef.current = playback;
  commandCallbackRef.current = onPlaybackCommand;

  useEffect(() => {
    if (!isYouTubeVideoId(videoId)) {
      setStatus('invalid');
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setErrorMessage('');
    setAutoplayBlocked(false);
    setPlayerState(-1);
    setCurrentTime(0);
    setDuration(0);
    lastAppliedRevisionRef.current = -1;

    loadYouTubeIframeApi()
      .then((youtube) => {
        if (cancelled || !mountRef.current) return;

        playerRef.current = new youtube.Player(mountRef.current, {
          videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            enablejsapi: 1,
            fs: 0,
            playsinline: 1,
            ...( /^https?:\/\//i.test(window.location.origin)
              ? { origin: window.location.origin }
              : {}),
            rel: 0,
          },
          events: {
            onReady: (event) => {
              if (cancelled) {
                event.target.destroy();
                return;
              }
              playerRef.current = event.target;
              event.target.getIframe?.().setAttribute('title', 'Vídeo do YouTube compartilhado na sala');
              setStatus('ready');
              setDuration(finiteTime(event.target.getDuration?.()));
              timerRef.current = window.setInterval(() => {
                const player = playerRef.current;
                if (!player) return;
                setCurrentTime(finiteTime(player.getCurrentTime?.()));
                setDuration(finiteTime(player.getDuration?.()));
                setPlayerState(player.getPlayerState?.() ?? -1);
              }, 500);
            },
            onStateChange: (event) => {
              if (cancelled) return;
              setPlayerState(event.data);
              if (event.data === 1) setAutoplayBlocked(false);
              const time = finiteTime(event.target.getCurrentTime?.());
              setCurrentTime(time);
              setDuration(finiteTime(event.target.getDuration?.()));
            },
            onAutoplayBlocked: () => {
              if (!cancelled) setAutoplayBlocked(true);
            },
            onError: (event) => {
              if (cancelled) return;
              setErrorMessage(getEmbedErrorMessage(event.data));
              setStatus('error');
            },
          },
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error.message || 'Não foi possível carregar o player do YouTube.');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || status !== 'ready' || !playback) return;

    const { action, currentTime: requestedTime, updatedAt, revision } = playback;
    if (!['play', 'pause', 'seek'].includes(action) || !Number.isFinite(requestedTime)) return;
    if (!Number.isInteger(revision) || revision <= lastAppliedRevisionRef.current) return;
    lastAppliedRevisionRef.current = revision;

    let targetTime = clampToDuration(requestedTime, player.getDuration?.());
    if (action === 'play') targetTime += getPlaybackAgeSeconds(updatedAt);
    targetTime = clampToDuration(targetTime, player.getDuration?.());
    const actualTime = finiteTime(player.getCurrentTime?.());
    if (action === 'seek') {
      player.seekTo(targetTime, true);
    } else {
      if (Math.abs(actualTime - targetTime) > 1.5) player.seekTo(targetTime, true);
      if (action === 'play') player.playVideo();
      else player.pauseVideo();
    }
  }, [playback?.action, playback?.currentTime, playback?.updatedAt, playback?.revision, status]);

  const isPlaying = playerState === 1;
  const safeDuration = Math.max(0, duration);

  function requestLocalCommand(action, requestedTime = finiteTime(playerRef.current?.getCurrentTime?.())) {
    const time = finiteTime(requestedTime);
    commandCallbackRef.current?.(action, time);
    return time;
  }

  function handleTogglePlayback() {
    const player = playerRef.current;
    if (!player) return;

    if (isPlaying || player.getPlayerState?.() === 1) {
      const time = requestLocalCommand('pause');
      player.pauseVideo();
      setCurrentTime(time);
      return;
    }

    const time = requestLocalCommand('play');
    setAutoplayBlocked(false);
    player.playVideo();
    setCurrentTime(time);
  }

  function handleSeekPreview(event) {
    const time = finiteTime(Number(event.currentTarget.value));
    setCurrentTime(time);
    playerRef.current?.seekTo?.(time, false);
  }

  function commitSeek() {
    const player = playerRef.current;
    if (!player) return;
    requestLocalCommand('seek', currentTime);
    player.seekTo(currentTime, true);
    setCurrentTime(currentTime);
  }

  const shouldShowStartButton = status === 'ready' && !isPlaying;

  return (
    <section className="youtube-room-player" aria-label="Vídeo do YouTube da sala">
      <div className="youtube-room-player__viewport">
        <div className="youtube-room-player__mount" ref={mountRef} />

        {status === 'loading' && (
          <p className="youtube-room-player__message" role="status">Carregando vídeo do YouTube…</p>
        )}

        {status === 'invalid' && (
          <p className="youtube-room-player__message" role="alert">O código deste vídeo do YouTube é inválido.</p>
        )}

        {status === 'error' && (
          <p className="youtube-room-player__message" role="alert">{errorMessage}</p>
        )}

        {shouldShowStartButton && (
          <div className="youtube-room-player__start-overlay">
            <p className="youtube-room-player__message" role="status">
              {autoplayBlocked
                ? 'O navegador bloqueou a reprodução automática. Toque para iniciar o vídeo.'
                : 'O vídeo está pronto para ser reproduzido.'}
            </p>
            <button className="youtube-room-player__start" type="button" onClick={handleTogglePlayback}>
              Tocar para iniciar vídeo
            </button>
          </div>
        )}
      </div>

      <div className="youtube-room-player__controls" aria-label="Controles do vídeo">
        <button
          className="youtube-room-player__toggle"
          type="button"
          onClick={handleTogglePlayback}
          disabled={status !== 'ready'}
          aria-label={isPlaying ? 'Pausar vídeo' : 'Reproduzir vídeo'}
        >
          {isPlaying ? 'Pausar' : 'Reproduzir'}
        </button>
        <label className="youtube-room-player__timeline">
          <span className="youtube-room-player__time">{formatTime(currentTime)}</span>
          <span className="sr-only">Progresso do vídeo</span>
          <input
            type="range"
            min="0"
            max={Math.max(1, safeDuration)}
            step="1"
            value={Math.min(currentTime, Math.max(1, safeDuration))}
            onChange={handleSeekPreview}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            disabled={status !== 'ready' || safeDuration <= 0}
            aria-label="Progresso do vídeo"
          />
          <span className="youtube-room-player__time">{formatTime(duration)}</span>
        </label>
      </div>
    </section>
  );
}
