import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_STREAM_QUALITY, STREAM_QUALITY_OPTIONS } from '../streamQuality.mjs';
import { requestScreenCapture, stopScreenCapture } from '../screenCapture.mjs';
import WindowCaptureCompatibilityOption from './WindowCaptureCompatibilityOption.jsx';

export default function ScreenShareSourcePicker({ onSelecionar, onFechar }) {
  const electronAPI = window.electronAPI;
  const hasNativeSources = Boolean(electronAPI?.listarFontesCompartilhamento);
  const [fontes, setFontes] = useState([]);
  const [selecionada, setSelecionada] = useState('');
  const [quality, setQuality] = useState(DEFAULT_STREAM_QUALITY);
  const [carregando, setCarregando] = useState(hasNativeSources);
  const [erro, setErro] = useState('');
  const [compartilhando, setCompartilhando] = useState(false);
  const pedidoCapturaRef = useRef(0);
  const controladorCapturaRef = useRef(null);

  function cancelarPedidoCaptura() {
    pedidoCapturaRef.current += 1;
    controladorCapturaRef.current?.abort();
    controladorCapturaRef.current = null;
  }

  useEffect(() => () => cancelarPedidoCaptura(), []);

  function fechar() {
    cancelarPedidoCaptura();
    onFechar();
  }

  useEffect(() => {
    let ativo = true;
    async function carregarFontes() {
      if (!hasNativeSources) {
        setFontes([{ id: 'browser-display', name: 'Tela ou janela', tipo: 'browser' }]);
        setSelecionada('browser-display');
        return;
      }
      try {
        const lista = await electronAPI.listarFontesCompartilhamento();
        if (!ativo) return;
        setFontes(lista);
        if (lista.length) setSelecionada(lista[0].id);
      } catch (error) {
        if (ativo) setErro(`Não consegui listar as telas: ${error.message}`);
      } finally {
        if (ativo) setCarregando(false);
      }
    }
    carregarFontes();
    return () => { ativo = false; };
  }, [electronAPI, hasNativeSources]);

  const fonteSelecionada = useMemo(() => fontes.find((fonte) => fonte.id === selecionada), [fontes, selecionada]);
  const atualizar = (campo, valor) => setQuality((atual) => ({ ...atual, [campo]: valor }));

  async function confirmar() {
    if (!fonteSelecionada) return;
    controladorCapturaRef.current?.abort();
    const controller = new AbortController();
    controladorCapturaRef.current = controller;
    const pedido = ++pedidoCapturaRef.current;
    setErro('');
    if (fonteSelecionada.tipo !== 'browser') {
      onSelecionar({
        ...quality,
        fonteId: fonteSelecionada.id,
        modoCaptura: fonteSelecionada.tipo === 'janela' ? 'compatibilidade' : 'padrao',
      });
      return;
    }

    setCompartilhando(true);
    try {
      const stream = await requestScreenCapture(quality, null, { signal: controller.signal });
      if (pedido !== pedidoCapturaRef.current) {
        await stopScreenCapture(stream, null);
        return;
      }
      onSelecionar({ ...quality, stream });
    } catch (error) {
      if (pedido !== pedidoCapturaRef.current) return;
      setErro(error?.name === 'NotAllowedError' || error?.name === 'AbortError'
        ? 'A captura foi cancelada. Você pode escolher uma tela quando estiver pronto.'
        : 'Não consegui iniciar a captura. Verifique se este navegador permite compartilhar tela.');
      setCompartilhando(false);
    }
  }

  return (
    <div className="modal-overlay screen-picker-overlay" onClick={fechar}>
      <section className="modal screen-picker-modal screen-picker-modal--rooms" role="dialog" aria-modal="true" aria-labelledby="screen-picker-title" onClick={(event) => event.stopPropagation()}>
        <header className="screen-picker-heading">
          <div>
            <p className="rooms-eyebrow">ASTRALIS · COMPARTILHAR</p>
            <h2 id="screen-picker-title">O que você quer transmitir?</h2>
            <p>Apenas a tela e o áudio escolhido. Microfone e conversa ficam no Discord.</p>
          </div>
          <button type="button" className="screen-picker-close" onClick={fechar} aria-label="Fechar seletor">×</button>
        </header>

        {carregando ? <p className="screen-picker-loading">Buscando telas disponíveis…</p> : erro && !fontes.length ? (
          <p className="rooms-error" role="alert">{erro}</p>
        ) : (
          <div className="screen-picker-content">
            <div className="screen-picker-grid" aria-label="Fontes de tela">
              {fontes.map((fonte) => (
                <button type="button" key={fonte.id} className={`screen-picker-item ${selecionada === fonte.id ? 'selecionada' : ''}`} onClick={() => setSelecionada(fonte.id)} aria-pressed={selecionada === fonte.id}>
                  {fonte.thumbnail ? <img src={fonte.thumbnail} alt="" className="screen-picker-thumb" /> : <span className="screen-picker-browser-icon" aria-hidden="true">▣</span>}
                  <span className="screen-picker-label">{fonte.name}</span>
                  {fonte.tipo === 'browser' && <small>O navegador vai mostrar a lista de telas</small>}
                </button>
              ))}
            </div>

            <div className="screen-quality-card">
              <label className="screen-quality-adaptive">
                <input type="checkbox" checked={quality.adaptiveQuality} onChange={(event) => atualizar('adaptiveQuality', event.target.checked)} />
                <span><strong>Qualidade inteligente</strong><small>{quality.adaptiveQuality
                  ? 'O Astralis ajusta o envio à conexão de cada espectador e divide o upload disponível.'
                  : 'Cada espectador recebe o perfil completo; o uso de upload cresce com cada pessoa.'}</small></span>
              </label>
              <fieldset className="screen-content-type">
                <legend>O que você está compartilhando</legend>
                <label className={quality.contentType === 'detail' ? 'selected' : ''}>
                  <input type="radio" name="screen-content-type" value="detail" checked={quality.contentType === 'detail'} onChange={() => atualizar('contentType', 'detail')} />
                  <span><strong>Texto / código</strong><small>Prioriza nitidez</small></span>
                </label>
                <label className={quality.contentType === 'motion' ? 'selected' : ''}>
                  <input type="radio" name="screen-content-type" value="motion" checked={quality.contentType === 'motion'} onChange={() => atualizar('contentType', 'motion')} />
                  <span><strong>Vídeo / jogo</strong><small>Prioriza fluidez</small></span>
                </label>
              </fieldset>
              <div className="screen-quality-selects">
                <label>Resolução
                  <select value={quality.resolution} onChange={(event) => atualizar('resolution', event.target.value)}>
                    {STREAM_QUALITY_OPTIONS.resolutions.map((value) => <option key={value} value={value}>{value === '1080p' ? 'Full HD (1080p)' : value}</option>)}
                  </select>
                </label>
              </div>
              <p className="screen-quality-note">60 fps · Melhor qualidade por padrão. A fluidez depende da tela, do computador e da conexão.</p>
              <label className="screen-quality-audio">
                <input type="checkbox" checked={quality.shareAudio} onChange={(event) => atualizar('shareAudio', event.target.checked)} />
                Compartilhar o áudio da tela
              </label>
              {fonteSelecionada?.tipo === 'janela' && (
                <WindowCaptureCompatibilityOption visible />
              )}
              <p className="screen-quality-note">Filtro do Discord ativado automaticamente. Se o filtro não estiver disponível, a tela será compartilhada sem áudio.</p>
            </div>
          </div>
        )}

        {erro && <p className="rooms-error screen-picker-error" role="alert">{erro}</p>}
        <footer className="screen-picker-actions">
          <button type="button" className="rooms-secondary-button" onClick={fechar}>Cancelar</button>
          <button type="button" className="rooms-primary-button" disabled={!fonteSelecionada || carregando || compartilhando} onClick={confirmar}>
            {compartilhando ? 'Aguardando permissão…' : 'Compartilhar'}
          </button>
        </footer>
      </section>
    </div>
  );
}
