import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let StreamDiagnostics;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });
  ({ default: StreamDiagnostics } = await vite.ssrLoadModule('/src/components/StreamDiagnostics.jsx'));
});

after(async () => { await vite?.close(); });

test('stream diagnostics: flags old metrics when the peer is disconnected', () => {
  const markup = renderToStaticMarkup(React.createElement(StreamDiagnostics, {
    outbound: true,
    diagnostics: {
      peers: [{
        peerId: 'viewer-a',
        connectionState: 'disconnected',
        targetVideoBitrate: 2_000_000,
        metrics: { direction: 'outbound', sampledAt: Date.now() - 30_000, qualityLimitationReason: 'none' },
      }],
    },
    quality: { bitrate: 4_000_000, adaptiveQuality: true },
  }));
  assert.match(markup, /Conexão: Desconectado/);
  assert.match(markup, /última amostra há 30s/);
  assert.match(markup, /métricas antigas/);
});


test('stream diagnostics: shows sanitized ICE states, candidate counts, and error code', () => {
  const markup = renderToStaticMarkup(React.createElement(StreamDiagnostics, {
    diagnostics: {
      peers: [{
        peerId: 'host-a',
        connectionState: 'connecting',
        ice: {
          connectionState: 'connecting',
          iceConnectionState: 'checking',
          iceGatheringState: 'complete',
          candidateCounts: { host: 2, srflx: 1, prflx: 0, relay: 1 },
          candidateErrorCount: 1,
          lastCandidateErrorCode: 701,
        },
        metrics: null,
      }],
    },
  }));

  assert.match(markup, /ICE: Verificando caminho/);
  assert.match(markup, /candidatos host 2 \/ srflx 1 \/ prflx 0 \/ relay 1/);
  assert.match(markup, /erros ICE 1 \(código 701\)/);
  assert.equal(markup.includes('address'), false);
});
