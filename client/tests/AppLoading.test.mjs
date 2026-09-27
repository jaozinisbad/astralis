import assert from 'node:assert/strict';
import { after, before, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalGlobals = {
  fetch: globalThis.fetch,
  localStorage: globalThis.localStorage,
  window: globalThis.window,
};
let vite;
let App;
let raiz;
let chamadasFetch;

function pluginDeStubs() {
  return {
    name: 'app-loading-test-stubs',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'socket.io-client') return '\0socket.io-client-test-stub';
      const componente = id.match(/^\.\/components\/(.+)\.jsx$/);
      return componente ? `\0componente-test-stub:${componente[1]}` : null;
    },
    load(id) {
      if (id === '\0socket.io-client-test-stub') {
        return `export const io = () => ({ on() {}, off() {}, once() {}, emit() {}, disconnect() {} });`;
      }
      if (!id.startsWith('\0componente-test-stub:')) return null;
      const nome = id.slice('\0componente-test-stub:'.length);
      if (nome === 'ServerSidebar') {
        return `import React from 'react';
          export default function ServerSidebar(props) {
            return React.createElement('nav', null, ...props.servidores.map((servidor) =>
              React.createElement('button', { key: servidor.id, 'data-select-server': servidor.id,
                onClick: () => props.onSelecionar(servidor.id) }, servidor.nome)));
          }`;
      }
      if (nome === 'ChannelSidebar') {
        return `import React from 'react';
          export default function ChannelSidebar(props) {
            return React.createElement('aside', { 'data-channel-server': props.servidorNome,
              'data-channels': JSON.stringify(props.canais) });
          }`;
      }
      return `export default function ${nome}() { return null; }`;
    },
  };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    plugins: [pluginDeStubs()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ default: App } = await vite.ssrLoadModule('/src/App.jsx'));
});

after(async () => {
  await vite?.close();
});

afterEach(async () => {
  if (raiz) {
    await act(async () => raiz.unmount());
    raiz = null;
  }
  globalThis.fetch = originalGlobals.fetch;
  globalThis.localStorage = originalGlobals.localStorage;
  globalThis.window = originalGlobals.window;
});

function respostaAdiada() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function prepararAplicacao() {
  const fila = new Map();
  const sessao = JSON.stringify({
    token: 'token-teste',
    usuario: { id: 'user-1', nome: 'Jogador', status: 'online' },
  });
  const armazenamento = {
    getItem: (chave) => chave === 'sessao' ? sessao : null,
    setItem() {},
    removeItem() {},
  };
  globalThis.localStorage = armazenamento;
  globalThis.window = new EventTarget();
  globalThis.window.electronAPI = undefined;
  chamadasFetch = [];
  globalThis.fetch = (url) => {
    const caminho = new URL(url).pathname;
    chamadasFetch.push(caminho);
    if (caminho === '/api/servidores' || /\/canais$/.test(caminho)) {
      const entrada = fila.get(caminho) || [];
      if (!entrada.length) entrada.push(respostaAdiada());
      fila.set(caminho, entrada);
      return entrada[0].promise;
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  };
  return {
    buscar: (caminho) => {
      const entrada = fila.get(caminho);
      assert.ok(entrada?.length, `não há resposta pendente para ${caminho}`);
      return entrada[0];
    },
    resolver(caminho, dados) {
      const deferred = this.buscar(caminho);
      fila.get(caminho).shift();
      deferred.resolve({ ok: true, status: 200, json: async () => dados });
    },
    rejeitar(caminho, status, mensagem) {
      const deferred = this.buscar(caminho);
      fila.get(caminho).shift();
      deferred.resolve({ ok: false, status, json: async () => ({ erro: mensagem }) });
    },
  };
}

async function renderizar() {
  await act(async () => {
    raiz = TestRenderer.create(React.createElement(App));
    await Promise.resolve();
  });
}

function textoDaArvore() {
  return raiz.root.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    .join(' ');
}

test('mostra carregamento enquanto busca servidores da sessão salva', async () => {
  const api = prepararAplicacao();
  await renderizar();

  assert.ok(chamadasFetch.includes('/api/servidores'));
  assert.match(textoDaArvore(), /Carregando seus servidores/);
  assert.doesNotMatch(textoDaArvore(), /Nenhum servidor/);
});

test('permite tentar novamente após falha e apresenta os servidores no sucesso', async () => {
  const api = prepararAplicacao();
  await renderizar();
  await act(async () => api.rejeitar('/api/servidores', 503, 'Servidor indisponível'));
  assert.match(textoDaArvore(), /Servidor indisponível/);

  await act(async () => {
    raiz.root.findAllByType('button').find((button) => button.children.join('') === 'Tentar novamente').props.onClick();
  });
  assert.equal(chamadasFetch.filter((caminho) => caminho === '/api/servidores').length, 2);
  assert.match(textoDaArvore(), /Carregando seus servidores/);

  await act(async () => api.resolver('/api/servidores', [{ id: 'alpha', nome: 'Alpha', papel: 'dono' }]));
  assert.ok(raiz.root.findAllByProps({ 'data-select-server': 'alpha' }).length === 1);
});

test('descarta resposta de canais de um servidor que deixou de estar ativo', async () => {
  const api = prepararAplicacao();
  await renderizar();
  await act(async () => api.resolver('/api/servidores', [
    { id: 'alpha', nome: 'Alpha', papel: 'dono' },
    { id: 'beta', nome: 'Beta', papel: 'dono' },
  ]));

  const respostaAlpha = api.buscar('/api/servidores/alpha/canais');
  await act(async () => {
    raiz.root.findByProps({ 'data-select-server': 'beta' }).props.onClick();
    await Promise.resolve();
  });
  await act(async () => api.resolver('/api/servidores/beta/canais', [{ id: 'beta-channel', nome: 'Canal Beta', tipo: 'texto' }]));
  await act(async () => {
    respostaAlpha.resolve({ ok: true, status: 200, json: async () => [{ id: 'alpha-channel', nome: 'Canal Alpha', tipo: 'texto' }] });
    await Promise.resolve();
  });

  const sidebar = raiz.root.findByType('aside');
  assert.equal(sidebar.props['data-channel-server'], 'Beta');
  assert.deepEqual(JSON.parse(sidebar.props['data-channels']), [
    { id: 'beta-channel', nome: 'Canal Beta', tipo: 'texto' },
  ]);
});

test('sessão salva é descartada quando a API de servidores retorna 401', async () => {
  const api = prepararAplicacao();
  await renderizar();
  await act(async () => api.rejeitar('/api/servidores', 401, 'Sessão expirada'));
  assert.ok(raiz.root.findAllByType('nav').length === 0);
});
