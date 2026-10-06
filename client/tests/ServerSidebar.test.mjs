import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let ServerSidebar;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ default: ServerSidebar } = await vite.ssrLoadModule('/src/components/ServerSidebar.jsx'));
});

after(async () => {
  await vite?.close();
});

function criarProps(overrides = {}) {
  return {
    servidores: [
      { id: 'alpha', nome: 'Alpha' },
      { id: 'beta', nome: 'Beta' },
    ],
    servidorAtivoId: 'alpha',
    viewAtiva: 'servidor',
    onSelecionar: () => {},
    onAbrirAmigos: () => {},
    onAbrirModal: () => {},
    ...overrides,
  };
}

function coletarElementos(elemento, resultado = []) {
  if (Array.isArray(elemento)) {
    elemento.forEach((filho) => coletarElementos(filho, resultado));
  } else if (React.isValidElement(elemento)) {
    resultado.push(elemento);
    coletarElementos(elemento.props.children, resultado);
  }
  return resultado;
}

test('mostra navegação acessível e destaca o servidor ativo', () => {
  const markup = renderToStaticMarkup(React.createElement(ServerSidebar, criarProps()));

  assert.match(markup, /aria-label="Abrir amigos"/);
  assert.match(markup, /aria-label="Abrir servidor Alpha"/);
  assert.match(markup, /aria-label="Abrir servidor Beta"/);
  assert.match(markup, /aria-label="Criar ou entrar em servidor"/);
  assert.match(markup, /server-icon active/);
  assert.equal((markup.match(/<button/g) || []).length, 4);
});

test('encaminha cliques de amigos, servidor e adicionar para as ações corretas', () => {
  const chamadas = [];
  const props = criarProps({
    onSelecionar: (id) => chamadas.push(['servidor', id]),
    onAbrirAmigos: () => chamadas.push(['amigos']),
    onAbrirModal: () => chamadas.push(['adicionar']),
  });
  const botoes = coletarElementos(ServerSidebar(props)).filter((elemento) => elemento.type === 'button');

  botoes.find((botao) => botao.props['aria-label'] === 'Abrir amigos').props.onClick();
  botoes.find((botao) => botao.props['aria-label'] === 'Abrir servidor Beta').props.onClick();
  botoes.find((botao) => botao.props['aria-label'] === 'Criar ou entrar em servidor').props.onClick();

  assert.deepEqual(chamadas, [['amigos'], ['servidor', 'beta'], ['adicionar']]);
});
