import React, { useEffect, useId, useRef, useState } from 'react';
import { fetchLatestWindowsInstaller } from '../appDownload.mjs';
import './DownloadAppButton.css';

export default function DownloadAppButton({ className = '', variant = 'compact' }) {
  const [estado, setEstado] = useState('idle');
  const [erro, setErro] = useState('');
  const [versao, setVersao] = useState('');
  const pedidoRef = useRef(null);
  const descricaoId = useId();

  useEffect(() => () => {
    const pedido = pedidoRef.current;
    pedidoRef.current = null;
    pedido?.abort();
  }, []);

  const aplicativoDesktop = !!globalThis.window?.electronAPI;
  const navegador = globalThis.window?.navigator;
  const dispositivoMovel = navegador?.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|IEMobile|Windows Phone/i.test(navegador?.userAgent || '');

  async function baixarAplicativo() {
    if (aplicativoDesktop || dispositivoMovel || pedidoRef.current) return;
    const pedido = new AbortController();
    pedidoRef.current = pedido;
    setEstado('loading');
    setErro('');

    try {
      // Consulte a release somente após o clique, sem uma versão fixa no site.
      const instalador = await fetchLatestWindowsInstaller({ signal: pedido.signal });
      if (pedidoRef.current !== pedido || pedido.signal.aborted) return;
      globalThis.window.location.assign(instalador.url);
      setVersao(instalador.version);
      setEstado('requested');
    } catch (falha) {
      if (pedidoRef.current !== pedido || pedido.signal.aborted) return;
      setErro(falha?.message || 'Não foi possível preparar o download. Confira sua conexão e tente novamente.');
      setEstado('error');
    } finally {
      if (pedidoRef.current === pedido) pedidoRef.current = null;
    }
  }

  if (aplicativoDesktop || dispositivoMovel) return null;

  const preparando = estado === 'loading';

  return (
    <div className={('download-app download-app--' + variant + ' ' + className).trim()}>
      {variant === 'login' && <p className="download-app__intro">Prefere usar o app?</p>}
      <button
        className="download-app__button"
        type="button"
        onClick={baixarAplicativo}
        disabled={preparando}
        aria-busy={preparando}
        aria-describedby={descricaoId}
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5" />
        </svg>
        <span>{preparando ? 'Preparando download…'
          : estado === 'error' ? 'Tentar novamente'
            : estado === 'requested' ? 'Baixar novamente' : 'Baixar para Windows'}</span>
      </button>
      <div id={descricaoId} className="download-app__description">
        <p className="download-app__hint" role="status" aria-live="polite">
          {preparando ? 'Consultando a versão mais recente…'
            : estado === 'requested' ? 'Se o download não iniciar, tente novamente.'
              : 'Instalador para Windows · versão mais recente'}
        </p>
        {estado === 'requested' && versao && <p className="download-app__version">Windows · v{versao}</p>}
      </div>
      {erro && <p className="download-app__error" role="alert">{erro}</p>}
    </div>
  );
}
