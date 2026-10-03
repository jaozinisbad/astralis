import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
let vite;
let StreamRoomActionBar;
let loadError;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });

  try {
    ({ default: StreamRoomActionBar } = await vite.ssrLoadModule('/src/components/StreamRoomActionBar.jsx'));
  } catch (error) {
    loadError = error;
  }
});

after(async () => {
  await vite?.close();
});

function montar(props = {}) {
  assert.ok(StreamRoomActionBar, `A barra da sala precisa ser renderizável: ${loadError?.message || 'componente ausente'}`);
  return TestRenderer.create(React.createElement(StreamRoomActionBar, {
    isSharing: false,
    hasYouTubeSource: false,
    onShare() {},
    onStopShare() {},
    onAddYouTube() {},
    onSettings() {},
    onFullscreen() {},
    onExit() {},
    ...props,
  }));
}

function botao(renderer, nome) {
  return renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === nome);
}

test('expõe o dock como barra de ferramentas acessível e rotula cada ação', () => {
  const renderer = montar();
  const toolbar = renderer.root.find((item) => item.props.role === 'toolbar');

  assert.equal(toolbar.props['aria-label'], 'Ações da sala de transmissão');
  assert.equal(renderer.root.findAllByType('button').length, 5);
  assert.ok(renderer.root.findAllByType('button').every((item) => item.props.type === 'button' && item.props['aria-label']));
});

test('mantém foco visível e alvos de toque de pelo menos 44 pixels', () => {
  const styles = readFileSync(new URL('./StreamRoomActionBar.css', import.meta.url), 'utf8');

  assert.match(styles, /\.stream-room-action-bar__button:focus-visible/);
  assert.match(styles, /inline-size:\s*48px/);
  assert.match(styles, /block-size:\s*48px/);
  assert.match(styles, /inline-size:\s*44px/);
  assert.match(styles, /block-size:\s*44px/);
});

test('encaminha as cinco ações da sala e alterna compartilhar por parar', () => {
  const chamadas = [];
  const renderer = montar({
    isSharing: true,
    onShare: () => chamadas.push('compartilhar'),
    onStopShare: () => chamadas.push('parar'),
    onAddYouTube: () => chamadas.push('youtube'),
    onSettings: () => chamadas.push('configuracoes'),
    onFullscreen: () => chamadas.push('tela cheia'),
    onExit: () => chamadas.push('sair'),
  });

  assert.equal(botao(renderer, 'Parar compartilhamento').props['aria-pressed'], true);
  assert.ok(botao(renderer, 'Adicionar fonte do YouTube'));
  assert.ok(botao(renderer, 'Qualidade e configurações'));
  assert.ok(botao(renderer, 'Tela cheia'));
  assert.ok(botao(renderer, 'Sair da sala'));
  assert.equal(renderer.root.findAllByType('button').length, 5);

  botao(renderer, 'Parar compartilhamento').props.onClick();
  botao(renderer, 'Adicionar fonte do YouTube').props.onClick();
  botao(renderer, 'Qualidade e configurações').props.onClick();
  botao(renderer, 'Tela cheia').props.onClick();
  botao(renderer, 'Sair da sala').props.onClick();

  assert.deepEqual(chamadas, ['parar', 'youtube', 'configuracoes', 'tela cheia', 'sair']);
});

test('indica que a fonte única do YouTube já está ativa e impede adicionar outra', () => {
  const renderer = montar({ hasYouTubeSource: true });
  const botaoYouTube = botao(renderer, 'Fonte do YouTube adicionada');

  assert.ok(botaoYouTube);
  assert.equal(botaoYouTube.props.disabled, true);
});

test('reserva a troca da fonte do YouTube ao anfitrião', () => {
  const renderer = montar({ canManageSource: false });
  const botaoYouTube = botao(renderer, 'Apenas o anfitrião pode adicionar a fonte');

  assert.ok(botaoYouTube);
  assert.equal(botaoYouTube.props.disabled, true);
});

test('desabilita as ações da barra quando a sala está bloqueada', () => {
  const renderer = montar({ disabled: true });

  assert.equal(renderer.root.findAllByType('button').length, 5);
  assert.ok(renderer.root.findAllByType('button').every((item) => item.props.disabled));
});
