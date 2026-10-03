import React from 'react';
import './StreamRoomActionBar.css';

const ICONES = {
  screen: (
    <>
      <rect x="3.5" y="4.5" width="17" height="13" rx="2" />
      <path d="M8 21h8M12 17.5V21M12 7.5v7m-3-3 3 3 3-3" />
    </>
  ),
  youtube: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" />
      <path d="M19 3v4m-2-2h4" />
    </>
  ),
  settings: (
    <>
      <path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" />
      <path d="m19.4 13.5 1.1.85-1.5 2.6-1.3-.5a7.8 7.8 0 0 1-1.7 1l-.2 1.4h-3l-.2-1.4a7.8 7.8 0 0 1-1.7-1l-1.3.5-1.5-2.6 1.1-.85a7.1 7.1 0 0 1 0-2l-1.1-.85 1.5-2.6 1.3.5a7.8 7.8 0 0 1 1.7-1l.2-1.4h3l.2 1.4a7.8 7.8 0 0 1 1.7 1l1.3-.5 1.5 2.6-1.1.85a7.1 7.1 0 0 1 0 2Z" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
    </>
  ),
  exit: (
    <>
      <path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5" />
      <path d="M3 12h11m-4-4 4 4-4 4" />
    </>
  ),
};

function Icone({ nome }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONES[nome]}
    </svg>
  );
}

export default function StreamRoomActionBar({
  isSharing = false,
  hasYouTubeSource = false,
  canManageSource = true,
  shareDisabled = false,
  sourceDisabled = false,
  onShare,
  onStopShare,
  onAddYouTube,
  onSettings,
  onFullscreen,
  onExit,
  exitLabel = 'Sair da sala',
  disabled = false,
}) {
  const youtubeLabel = hasYouTubeSource
    ? 'Fonte do YouTube adicionada'
    : canManageSource ? 'Adicionar fonte do YouTube' : 'Apenas o anfitrião pode adicionar a fonte';

  return (
    <nav className="stream-room-action-bar" role="toolbar" aria-label="Ações da sala de transmissão">
      <button
        type="button"
        className={`stream-room-action-bar__button stream-room-action-bar__button--share${isSharing ? ' is-active' : ''}`}
        aria-label={isSharing ? 'Parar compartilhamento' : 'Compartilhar tela'}
        aria-pressed={Boolean(isSharing)}
        title={isSharing ? 'Parar compartilhamento' : 'Compartilhar tela'}
        disabled={disabled || shareDisabled}
        onClick={isSharing ? onStopShare : onShare}
      >
        <Icone nome="screen" />
      </button>

      <button
        type="button"
        className={`stream-room-action-bar__button stream-room-action-bar__button--youtube${hasYouTubeSource ? ' is-active' : ''}`}
        aria-label={youtubeLabel}
        title={youtubeLabel}
        disabled={disabled || sourceDisabled || hasYouTubeSource || !canManageSource}
        onClick={onAddYouTube}
      >
        <Icone nome="youtube" />
      </button>

      <button
        type="button"
        className="stream-room-action-bar__button stream-room-action-bar__button--settings"
        aria-label="Qualidade e configurações"
        title="Qualidade e configurações"
        disabled={disabled}
        onClick={onSettings}
      >
        <Icone nome="settings" />
      </button>

      <button
        type="button"
        className="stream-room-action-bar__button stream-room-action-bar__button--fullscreen"
        aria-label="Tela cheia"
        title="Tela cheia"
        disabled={disabled}
        onClick={onFullscreen}
      >
        <Icone nome="fullscreen" />
      </button>

      <button
        type="button"
        className="stream-room-action-bar__button stream-room-action-bar__button--exit"
        aria-label={exitLabel}
        title={exitLabel}
        disabled={disabled}
        onClick={onExit}
      >
        <Icone nome="exit" />
      </button>
    </nav>
  );
}
