import React, { useEffect, useState } from 'react';
import { getStreamStatsDiagnosis } from '../streamStats.mjs';
import { resolveStreamQuality } from '../streamQuality.mjs';

function formatBitrate(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 1_000_000
    ? `${(value / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`
    : `${Math.round(value / 1_000)} Kbps`;
}

function formatRate(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${suffix}` : '—';
}

function formatMilliseconds(seconds) {
  return Number.isFinite(seconds) ? `${Math.round(seconds * 1_000)} ms` : '—';
}

function formatLoss(value) {
  return Number.isFinite(value) ? `${(value * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%` : '—';
}

function limitationText(reason) {
  if (reason === 'cpu') return 'Codificador sinaliza possível limite de CPU';
  if (reason === 'bandwidth') return 'Codificador sinaliza possível limite de rede';
  if (reason === 'other') return 'Codificador relata outra limitação';
  if (reason === 'none') return 'Codificador sem limitação indicada';
  return 'Causa não informada pelo navegador';
}

function connectionStateText(state) {
  if (state === 'connected') return 'Conectado';
  if (state === 'connecting') return 'Conectando';
  if (state === 'disconnected') return 'Desconectado';
  if (state === 'failed') return 'Falhou';
  if (state === 'closed') return 'Encerrado';
  return 'Aguardando conexão';
}

function iceStateText(state) {
  if (state === 'connected' || state === 'completed') return 'Conectado';
  if (state === 'checking') return 'Verificando caminho';
  if (state === 'disconnected') return 'Desconectado';
  if (state === 'failed') return 'Falhou';
  if (state === 'closed') return 'Encerrado';
  if (state === 'new') return 'Aguardando negociação';
  return 'Estado indisponível';
}

function StreamMetrics({ peer, index, outbound }) {
  const metrics = peer?.metrics;
  const diagnosis = getStreamStatsDiagnosis(metrics || {});
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!metrics?.sampledAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [Boolean(metrics?.sampledAt)]);

  const connectionState = peer?.connectionState || 'connecting';
  const sampleAgeSeconds = Number.isFinite(metrics?.sampledAt)
    ? Math.max(0, Math.floor((now - metrics.sampledAt) / 1_000))
    : null;
  const stale = connectionState !== 'connected' || sampleAgeSeconds === null || sampleAgeSeconds > 5;

  return (
    <section className="stream-diagnostics-peer">
      <h4>{outbound ? `Espectador ${index + 1}` : 'Conexão recebida'}</h4>
      <p className={`stream-diagnostics-connection${stale ? ' is-stale' : ''}`}>
        Conexão: {connectionStateText(connectionState)}
        {sampleAgeSeconds !== null && ` · última amostra há ${sampleAgeSeconds}s`}
        {stale && metrics?.direction && ' · métricas antigas'}
      </p>
      {peer?.ice && <p className="stream-diagnostics-ice">
        ICE: {iceStateText(peer.ice.iceConnectionState)} · coleta {peer.ice.iceGatheringState || 'desconhecida'} · candidatos host {peer.ice.candidateCounts?.host ?? 0} / srflx {peer.ice.candidateCounts?.srflx ?? 0} / prflx {peer.ice.candidateCounts?.prflx ?? 0} / relay {peer.ice.candidateCounts?.relay ?? 0}
        {peer.ice.candidateErrorCount > 0 && ` · erros ICE ${peer.ice.candidateErrorCount}${Number.isFinite(peer.ice.lastCandidateErrorCode) ? ` (código ${peer.ice.lastCandidateErrorCode})` : ''}`}
      </p>}
      {!metrics?.direction ? <p className="stream-diagnostics-empty">Aguardando uma amostra do navegador…</p> : <>
        <dl>
          <div><dt>Vídeo efetivo</dt><dd>{metrics.frameWidth && metrics.frameHeight ? `${metrics.frameWidth} × ${metrics.frameHeight}` : '—'}{Number.isFinite(metrics.framesPerSecond) ? ` · ${formatRate(metrics.framesPerSecond, ' FPS')}` : ''}</dd></div>
          <div><dt>Bitrate de vídeo</dt><dd>{formatBitrate(metrics.bitrateBps)}</dd></div>
          {outbound && <div><dt>Limite desta conexão</dt><dd>{formatBitrate(peer.targetVideoBitrate)}</dd></div>}
          {outbound && <div><dt>Banda estimada</dt><dd>{formatBitrate(peer.availableOutgoingBitrate)}</dd></div>}
          <div><dt>Codec</dt><dd>{metrics.codec || '—'}</dd></div>
          <div><dt>RTT</dt><dd>{formatMilliseconds(metrics.roundTripTimeSeconds)}</dd></div>
          <div><dt>Perda de pacotes</dt><dd>{formatLoss(metrics.fractionLost)}</dd></div>
          <div><dt>Jitter</dt><dd>{formatMilliseconds(metrics.jitterSeconds)}</dd></div>
        </dl>
        {outbound && <p className={`stream-diagnostics-status is-${diagnosis.status}`}>
          {limitationText(metrics.qualityLimitationReason)}. {diagnosis.text}
        </p>}
        {!outbound && (metrics.framesDropped !== null || metrics.freezeCount !== null) && <p className="stream-diagnostics-status">
          Quadros descartados: {metrics.framesDropped ?? '—'} · travamentos: {metrics.freezeCount ?? '—'}
        </p>}
      </>}
    </section>
  );
}

export default function StreamDiagnostics({ diagnostics, quality, outbound = false }) {
  const profile = outbound ? resolveStreamQuality(quality || {}) : null;
  const peers = diagnostics?.peers || [];

  return (
    <section className="stream-room-participants__diagnostics" aria-label="Diagnóstico da transmissão">
      <header><h3>Diagnóstico</h3><span>{outbound ? 'envio' : 'recepção'}</span></header>
      {profile && <p className="stream-diagnostics-profile">
        <strong>Perfil selecionado:</strong> {profile.resolution} · {profile.fps} FPS · {profile.adaptiveQuality
          ? `até ${formatBitrate(profile.bitrate)} no total do vídeo`
          : `até ${formatBitrate(profile.bitrate)} por espectador`}
      </p>}
      {outbound && diagnostics?.adaptiveQuality && <p className="stream-diagnostics-note">
        O limite total é dividido entre espectadores; estimativas disponíveis podem redistribuir o orçamento.
      </p>}
      {!peers.length
        ? <p className="stream-diagnostics-empty">{outbound ? 'As métricas aparecem quando alguém se conecta à transmissão.' : 'Conectando ao transmissor…'}</p>
        : peers.map((peer, index) => <StreamMetrics key={peer.peerId || index} peer={peer} index={index} outbound={outbound} />)}
      <p className="stream-diagnostics-footnote">Métricas do WebRTC no navegador; valores podem variar entre amostras e alguns campos podem não estar disponíveis.</p>
    </section>
  );
}
