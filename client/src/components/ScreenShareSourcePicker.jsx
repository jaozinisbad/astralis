import React, { useEffect, useMemo, useState } from 'react';
import { DEFAULT_STREAM_QUALITY, STREAM_QUALITY_OPTIONS } from '../streamQuality.mjs';
import { requestScreenCapture } from '../screenCapture.mjs';

const LABEL_BITRATE = new Map([
  [700_000, 'Baixo · ~700 Kbps'], [2_000_000, 'Médio · ~2 Mbps'],
  [4_000_000, 'Alto · ~4 Mbps'], [8_000_000, 'Ultra · ~8 Mbps'],
  [16_000_000, 'Máximo · ~16 Mbps'],
]);

export default function ScreenShareSourcePicker({ onSelecionar, onFechar }) {
  const electronAPI = window.electronAPI;
  const hasNativeSources = Boolean(electronAPI?.listarFontesCompartilhamento);
  const [fontes, setFontes] = useState([]);
  const [selecionada, setSelecionada] = useState('');
  const [quality, setQuality] = useState(DEFAULT_STREAM_QUALITY);
  const [carregando, setCarregando] = useState(hasNativeSources);
  const [erro, setErro] = useState('');
  const [compartilhando, setCompartilhando] = useState(false);

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
      const stream = await requestScreenCapture(quality, null);
      onSelecionar({ ...quality, stream });
    } catch (error) {
      setErro(error?.name === 'NotAllowedError' || error?.name === 'AbortError'
        ? 'A captura foi cancelada. Você pode escolher uma tela quando estiver pronto.'
        : 'Não consegui iniciar a captura. Verifique se este navegador permite compartilhar tela.');
      setCompartilhando(false);
    }
  }

  return (
    <div className="modal-overlay screen-picker-overlay" onClick={onFechar}>
      <section className="modal screen-picker-modal screen-picker-modal--rooms" role="dialog" aria-modal="true" aria-labelledby="screen-picker-title" onClick={(event) => event.stopPropagation()}>
        <header className="screen-picker-heading">
          <div>
            <p className="rooms-eyebrow">ASTRALIS · COMPARTILHAR</p>
            <h2 id="screen-picker-title">O que você quer transmitir?</h2>
            <p>Apenas a tela e o áudio escolhido. Microfone e conversa ficam no Discord.</p>
          </div>
          <button type="button" className="screen-picker-close" onClick={onFechar} aria-label="Fechar seletor">×</button>
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
                  ? 'Divide o limite de bitrate entre espectadores para poupar upload; a rede ainda pode reduzir o valor real.'
                  : `Prioriza até ${(quality.bitrate / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps por espectador. O upload cresce por pessoa e a rede ainda pode reduzir o valor real.`}</small></span>
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
                <label>Taxa de quadros
                  <select value={quality.fps} onChange={(event) => atualizar('fps', Number(event.target.value))}>
                    {STREAM_QUALITY_OPTIONS.fps.map((value) => <option key={value} value={value}>{value} fps</option>)}
                  </select>
                </label>
                <label>Bitrate máximo
                  <select value={quality.bitrate} onChange={(event) => atualizar('bitrate', Number(event.target.value))}>
                    {STREAM_QUALITY_OPTIONS.bitrates.map((value) => <option key={value} value={value}>{LABEL_BITRATE.get(value)}</option>)}
                  </select>
                  <small>16 Mbps é um teto, não uma garantia: upload, Wi‑Fi e capacidade do computador influenciam o resultado.</small>
                </label>
              </div>
              <label className="screen-quality-audio">
                <input type="checkbox" checked={quality.shareAudio} onChange={(event) => atualizar('shareAudio', event.target.checked)} />
                Compartilhar o áudio da tela
              </label>
              {hasNativeSources && fonteSelecionada?.tipo === 'tela' && (
                <label className="screen-quality-audio screen-quality-audio--advanced">
                  <input type="checkbox" checked={quality.ignoreDiscordAudio} onChange={(event) => atualizar('ignoreDiscordAudio', event.target.checked)} />
                  Não enviar o áudio do Discord aos espectadores <small>Experimental · Windows</small>
                </label>
              )}
            </div>
          </div>
        )}

        {erro && <p className="rooms-error screen-picker-error" role="alert">{erro}</p>}
        <footer className="screen-picker-actions">
          <button type="button" className="rooms-secondary-button" onClick={onFechar}>Cancelar</button>
          <button type="button" className="rooms-primary-button" disabled={!fonteSelecionada || carregando || compartilhando} onClick={confirmar}>
            {compartilhando ? 'Aguardando permissão…' : 'Compartilhar'}
          </button>
        </footer>
      </section>
    </div>
  );
}
