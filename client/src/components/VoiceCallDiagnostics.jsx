import React, { useEffect, useState } from 'react';
import { summarizeWebRtcStats } from '../streamStats.mjs';

function readConnection(report) {
  const rows = [...report.values()];
  const transport = rows.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
  const pair = rows.find((item) => item.id === transport?.selectedCandidatePairId);
  const local = rows.find((item) => item.id === pair?.localCandidateId);
  const remote = rows.find((item) => item.id === pair?.remoteCandidateId);
  return {
    relay: local && remote ? [local, remote].some((candidate) => candidate.candidateType === 'relay') : null,
    latency: Number.isFinite(pair?.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
  };
}

export default function VoiceCallDiagnostics({ peersRef, stream, selectedId, local }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const track = stream?.getVideoTracks()[0];
  const hasAudio = stream?.getAudioTracks().some((item) => item.readyState !== 'ended');

  useEffect(() => {
    setResult(null);
    if (!open) return undefined;
    let active = true;
    let timer;
    const previousByPeer = new WeakMap();
    async function sample() {
      const peers = track && !local ? [peersRef.current[selectedId]] : Object.values(peersRef.current);
      const rows = (await Promise.all(peers.filter((pc) => pc?.connectionState === 'connected').map(async (pc) => {
        try {
          const connection = readConnection(await pc.getStats());
          if (!track) return { connection };
          const report = await pc.getStats(track);
          const { metrics, counters } = summarizeWebRtcStats(report, previousByPeer.get(pc));
          if (counters) previousByPeer.set(pc, counters);
          return { connection, metrics: metrics.direction ? metrics : null };
        } catch { return null; }
      }))).filter(Boolean);
      if (!active) return;
      const measured = rows.map((row) => row.metrics).filter((metrics) => metrics?.frameHeight > 0);
      const video = measured.sort((a, b) => a.frameHeight - b.frameHeight
        || (a.framesPerSecond ?? Infinity) - (b.framesPerSecond ?? Infinity))[0];
      const latencies = rows.map(({ connection }) => connection.latency).filter(Number.isFinite);
      const routes = rows.map(({ connection }) => connection.relay).filter((value) => value !== null);
      setResult({
        stream, selectedId, video,
        senders: measured.length,
        latency: latencies.length ? Math.max(...latencies) : null,
        route: routes.includes(true) && routes.includes(false) ? 'Direta e TURN'
          : routes.includes(true) ? 'Servidor de retransmissão (TURN)'
            : routes.length ? 'Direta' : null,
      });
      timer = setTimeout(sample, 2_000);
    }
    void sample();
    return () => { active = false; clearTimeout(timer); };
  }, [open, peersRef, track, stream, selectedId, local]);

  const current = result?.stream === stream && result?.selectedId === selectedId ? result : null;
  const metrics = current?.video;
  const quality = [metrics?.frameHeight && `${metrics.frameHeight}p`,
    Number.isFinite(metrics?.framesPerSecond) && `${Math.round(metrics.framesPerSecond)} FPS`].filter(Boolean).join(' · ');
  return <details className="voice-stage__diagnostics" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Diagnóstico da chamada</summary>
    {open && <div className="voice-stage__diagnostics-body">
      <dl>
        <div><dt>Conexão</dt><dd>{current?.route ?? 'Aguardando conexão com participantes'}</dd></div>
        {current?.latency != null && <div><dt>Latência</dt><dd>{current.latency} ms</dd></div>}
        {track && <div><dt>{local ? current?.senders > 1 ? 'Menor qualidade enviada' : 'Qualidade enviada' : 'Qualidade recebida'}</dt><dd>{quality || 'Coletando dados do vídeo'}</dd></div>}
        {track && <div><dt>Áudio da tela</dt><dd>{hasAudio ? 'Disponível' : 'Sem áudio compartilhado'}</dd></div>}
      </dl>
      {metrics?.qualityLimitationReason === 'bandwidth' && <p>A conexão está limitando a qualidade da transmissão.</p>}
      {metrics?.qualityLimitationReason === 'cpu' && <p>O processamento de vídeo está limitando a qualidade da transmissão.</p>}
    </div>}
  </details>;
}
