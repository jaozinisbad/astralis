import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_STREAM_QUALITY, STREAM_QUALITY_OPTIONS } from '../streamQuality.mjs';
import { requestScreenCapture, stopScreenCapture } from '../screenCapture.mjs';
import { useDialogFocus } from '../useDialogFocus.mjs';
import WindowCaptureCompatibilityOption from './WindowCaptureCompatibilityOption.jsx';
import './ScreenShareSourcePicker.css';

function SourceIcon({ application = false, size = 32 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{application ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18m-14-2h.01m3 0h.01" /></> : <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" /></>}</svg>;
}

function sourceType(source) {
  return source.tipo === 'browser' ? 'browser' : source.tipo === 'janela' || source.id.startsWith('window:') ? 'janela' : 'tela';
}

export default function ScreenShareSourcePicker({ onSelecionar, onFechar, canalNome, contexto = 'room' }) {
  const electronAPI = window.electronAPI;
  const hasNativeSources = Boolean(electronAPI?.listarFontesCompartilhamento);
  const [fontes, setFontes] = useState([]);
  const [selecionada, setSelecionada] = useState('');
  const [tab, setTab] = useState(hasNativeSources ? 'janela' : 'browser');
  const [step, setStep] = useState('source');
  const [quality, setQuality] = useState(() => ({ ...DEFAULT_STREAM_QUALITY }));
  const [carregando, setCarregando] = useState(hasNativeSources);
  const [erro, setErro] = useState('');
  const [compartilhando, setCompartilhando] = useState(false);
  const pedidoCapturaRef = useRef(0);
  const controladorCapturaRef = useRef(null);
  const pedidoFontesRef = useRef(0);
  const ativoRef = useRef(true);
  const headingRef = useRef(null);

  function cancelarPedidoCaptura() {
    pedidoCapturaRef.current += 1;
    controladorCapturaRef.current?.abort();
    controladorCapturaRef.current = null;
  }
  const fechar = useCallback(() => { cancelarPedidoCaptura(); onFechar?.(); }, [onFechar]);
  const dialogRef = useDialogFocus(fechar);
  useEffect(() => { ativoRef.current = true; return () => { ativoRef.current = false; pedidoFontesRef.current++; cancelarPedidoCaptura(); }; }, []);

  const carregarFontes = useCallback(async () => {
    const pedido = ++pedidoFontesRef.current;
    setErro('');
    if (!hasNativeSources) {
      setFontes([{ id: 'browser-display', name: 'Escolher no navegador', tipo: 'browser' }]);
      setTab('browser'); setCarregando(false); return;
    }
    setCarregando(true);
    try {
      const result = await electronAPI.listarFontesCompartilhamento();
      if (!ativoRef.current || pedido !== pedidoFontesRef.current) return;
      const lista = Array.isArray(result) ? result.filter((source) => source && typeof source.id === 'string').map((source) => ({ ...source, name: source.name || 'Fonte sem nome' })) : [];
      setFontes(lista);
      setSelecionada((current) => lista.some((source) => source.id === current) ? current : '');
      setTab((current) => lista.some((source) => sourceType(source) === current) ? current : lista.some((source) => sourceType(source) === 'janela') ? 'janela' : 'tela');
    } catch (error) {
      if (ativoRef.current && pedido === pedidoFontesRef.current) setErro(`Não foi possível carregar as telas e os aplicativos. ${error.message || ''}`.trim());
    } finally { if (ativoRef.current && pedido === pedidoFontesRef.current) setCarregando(false); }
  }, [electronAPI, hasNativeSources]);
  useEffect(() => { carregarFontes(); }, [carregarFontes]);
  useEffect(() => { if (step === 'confirm') headingRef.current?.focus(); }, [step]);

  const fonteSelecionada = useMemo(() => fontes.find((source) => source.id === selecionada), [fontes, selecionada]);
  const visibleSources = fontes.filter((source) => sourceType(source) === tab);
  const atualizar = (campo, valor) => setQuality((current) => ({ ...current, [campo]: valor }));
  const destino = canalNome || (contexto === 'call' ? 'Canal de voz atual' : 'Sua sala de tela');
  const canProceed = Boolean(fonteSelecionada && sourceType(fonteSelecionada) === tab && !carregando);
  function chooseTab(next) { setTab(next); setErro(''); }
  function next() { if (canProceed) { setErro(''); setStep('confirm'); } }
  function back() { if (!compartilhando) { setErro(''); setStep('source'); } }

  async function confirmar() {
    if (!fonteSelecionada || compartilhando) return;
    controladorCapturaRef.current?.abort();
    const controller = new AbortController(); controladorCapturaRef.current = controller;
    const pedido = ++pedidoCapturaRef.current;
    setErro(''); setCompartilhando(true);
    let captured = null;
    try {
      if (sourceType(fonteSelecionada) === 'browser') {
        captured = await requestScreenCapture(quality, null, { signal: controller.signal });
        if (!ativoRef.current || pedido !== pedidoCapturaRef.current) { await stopScreenCapture(captured, null); return; }
        await onSelecionar({ ...quality, stream: captured });
      } else {
        await onSelecionar({ ...quality, fonteId: fonteSelecionada.id, modoCaptura: sourceType(fonteSelecionada) === 'janela' ? 'compatibilidade' : 'padrao' });
      }
    } catch (error) {
      if (captured) await stopScreenCapture(captured, null);
      if (!ativoRef.current || pedido !== pedidoCapturaRef.current) return;
      setErro(error?.name === 'NotAllowedError' || error?.name === 'AbortError'
        ? 'A captura foi cancelada. Escolha uma tela ou um aplicativo para tentar novamente.'
        : error?.message || 'Não foi possível iniciar a transmissão. Confira as permissões de captura e tente novamente.');
    } finally { if (ativoRef.current && pedido === pedidoCapturaRef.current) setCompartilhando(false); }
  }

  return <div className="as-share-overlay" onClick={fechar}><section ref={dialogRef} className="as-share-modal" role="dialog" aria-modal="true" aria-labelledby="as-share-title" aria-describedby="as-share-description" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
    <header className="as-share-header"><div className="as-share-brand"><img src="./astralis-mark.svg" alt="" /><span>Astralis</span></div><button type="button" className="as-share-close" onClick={fechar} aria-label="Fechar seletor de tela">×</button><h2 id="as-share-title" tabIndex={-1} ref={headingRef}>{step === 'source' ? 'Compartilhar sua tela' : 'Tudo pronto para transmitir?'}</h2><p id="as-share-description">{step === 'source' ? contexto === 'call' ? 'Escolha o que mostrar para quem está com você na chamada.' : 'Escolha o que mostrar para as pessoas da sua sala.' : contexto === 'call' ? 'Sua voz continua na chamada do Astralis enquanto você transmite.' : 'Confira os detalhes e comece a compartilhar com a sua galera.'}</p></header>
    <div className="as-share-body">
      {step === 'source' ? <>
        {hasNativeSources && <div className="as-share-tabs" role="tablist" aria-label="Tipo de compartilhamento">{[['janela', 'Aplicativos'], ['tela', 'Telas']].map(([id, name]) => <button key={id} id={`as-share-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="as-share-sources" onClick={() => chooseTab(id)}>{name}</button>)}</div>}
        {!hasNativeSources && <p className="as-share-browser-note">A lista de telas, janelas e abas será aberta pelo navegador depois da sua confirmação.</p>}
        {carregando ? <div className="as-share-empty" role="status"><span className="as-share-loading" aria-hidden="true" /><p>Buscando telas e aplicativos…</p></div> : erro ? <div className="as-share-empty"><p className="as-share-error" role="alert">{erro}</p><button type="button" className="as-share-secondary" onClick={carregarFontes}>Tentar novamente</button></div> : <div className="as-share-sources" id="as-share-sources" role={hasNativeSources ? 'tabpanel' : undefined} aria-labelledby={hasNativeSources ? `as-share-tab-${tab}` : undefined} aria-label={!hasNativeSources ? 'Fontes de tela' : undefined}>
          {visibleSources.map((source) => <button type="button" className={`as-share-source${selecionada === source.id ? ' is-selected' : ''}`} key={source.id} onClick={() => { setSelecionada(source.id); setErro(''); }} aria-pressed={selecionada === source.id} aria-label={`Compartilhar ${source.name}`}>
            <span className="as-share-thumbnail">{source.thumbnail ? <img src={source.thumbnail} alt="" /> : <SourceIcon application={sourceType(source) === 'janela'} />}<span className="as-share-source-check" aria-hidden="true">✓</span></span><span className="as-share-source-name">{source.name}</span>{sourceType(source) === 'browser' && <small>Você escolhe exatamente o que compartilhar.</small>}
          </button>)}
          {!visibleSources.length && <div className="as-share-empty"><SourceIcon application={tab === 'janela'} /><p>{tab === 'janela' ? 'Nenhum aplicativo disponível. Abra uma janela ou escolha a aba Telas.' : 'Nenhuma tela disponível para compartilhar.'}</p><button type="button" className="as-share-secondary" onClick={carregarFontes}>Atualizar lista</button></div>}
        </div>}
      </> : <>
        <div className="as-share-confirm-source"><span className="as-share-confirm-preview">{fonteSelecionada?.thumbnail ? <img src={fonteSelecionada.thumbnail} alt="" /> : <SourceIcon application={fonteSelecionada && sourceType(fonteSelecionada) === 'janela'} />}</span><div><span className="as-share-label">VOCÊ VAI COMPARTILHAR</span><strong>{fonteSelecionada?.name}</strong><button type="button" className="as-share-link" onClick={back} disabled={compartilhando}>Alterar</button></div></div>
        <div className="as-share-destination"><SourceIcon size={23} /><div><span className="as-share-label">{contexto === 'call' ? 'CANAL DE VOZ' : 'SALA DE TELA'}</span><strong>{destino}</strong></div><span className="as-share-live-badge">AO VIVO</span></div>
        <div className="as-share-quality"><label>QUALIDADE DA TRANSMISSÃO<select value={quality.resolution} onChange={(event) => atualizar('resolution', event.target.value)} disabled={compartilhando}>{[...STREAM_QUALITY_OPTIONS.resolutions].reverse().map((value) => <option key={value} value={value}>{value === '1080p' ? '1080p · Qualidade máxima' : value}</option>)}</select></label><div className="as-share-frame-rate"><span className="as-share-label">TAXA DE QUADROS</span><strong>60 FPS</strong><small>Ajuste de conexão automático</small></div></div>
        <label className="as-share-audio"><span><strong>Compartilhar áudio</strong><small>{hasNativeSources ? 'Inclui o áudio da fonte quando disponível.' : 'Neste navegador a transmissão pode continuar sem áudio.'}</small></span><input type="checkbox" checked={quality.shareAudio} onChange={(event) => atualizar('shareAudio', event.target.checked)} disabled={compartilhando} /><span className="as-share-switch" aria-hidden="true" /></label>
        <p className="as-share-audio-note">O áudio do Discord fica sempre excluído. Se não for possível isolá-lo com segurança, o Astralis compartilha sem áudio.</p>
        <details className="as-share-advanced"><summary>Opções avançadas</summary><label className="as-share-adaptive"><input type="checkbox" checked={quality.adaptiveQuality} onChange={(event) => atualizar('adaptiveQuality', event.target.checked)} disabled={compartilhando} /><span>Ajustar a qualidade à conexão <small>Recomendado para manter a transmissão estável.</small></span></label><fieldset disabled={compartilhando}><legend>Prioridade da imagem</legend>{[['motion', 'Vídeo e jogos', 'Mais fluidez'], ['detail', 'Texto e código', 'Mais nitidez']].map(([value, title, note]) => <label key={value}><input type="radio" name="as-share-content" checked={quality.contentType === value} onChange={() => atualizar('contentType', value)} /><span>{title}<small>{note}</small></span></label>)}</fieldset>{fonteSelecionada && sourceType(fonteSelecionada) === 'janela' && <WindowCaptureCompatibilityOption visible />}</details>
        {erro && <p className="as-share-error" role="alert">{erro}</p>}
      </>}
    </div>
    <footer className="as-share-footer"><button type="button" className="as-share-secondary" onClick={step === 'confirm' ? back : fechar} disabled={step === 'confirm' && compartilhando}>{step === 'confirm' ? 'Voltar' : 'Cancelar'}</button>{step === 'confirm' && compartilhando && <button type="button" className="as-share-cancel" onClick={fechar}>Cancelar</button>}<button type="button" className="as-share-primary" disabled={step === 'source' ? !canProceed : !fonteSelecionada || compartilhando} onClick={step === 'source' ? next : confirmar}>{step === 'source' ? 'Avançar' : compartilhando ? 'Iniciando transmissão…' : 'Transmitir ao vivo'}</button></footer>
  </section></div>;
}
