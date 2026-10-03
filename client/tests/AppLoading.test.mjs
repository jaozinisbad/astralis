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
        return `export const io = () => ({ connected: true, on() {}, off() {}, once() {}, disconnect() {},
          emit(evento, dados, callback) {
            if (evento === 'salas:entrar' && dados?.accessCode === 'ABCD2345' && !dados.roomId) {
              callback({ ok: true, room: { id: 'room-from-code', name: 'Sala pelo código', visibility: 'private' },
                role: 'viewer', hostSocketId: 'host-1', peerSocketIds: ['host-1'] });
            } else if (typeof callback === 'function') callback({ ok: false, error: 'Solicitação de sala inesperada.' });
          } });`;
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
      if (nome === 'RoomLobby') {
        return `import React from 'react';
          export default function RoomLobby(props) {
            return React.createElement('main', { 'data-room-lobby': 'true', 'data-room-user': props.usuario?.nome || 'Visitante' },
              React.createElement('button', { type: 'button', 'data-enter-private-room': 'true',
                onClick: () => props.onEntrar({ accessCode: 'ABCD2345' }) }, 'Entrar com código'));
          }`;
      }
      if (nome === 'StreamRoom') {
        return `import React from 'react';
          export default function StreamRoom(props) {
            return React.createElement('main', { 'data-stream-room': props.roomId, 'data-stream-role': props.role,
              'data-stream-joined': String(Boolean(props.joinedInitially)) },
              React.createElement('button', { type: 'button', 'data-request-share': 'true', onClick: props.onRequestShare }, 'Compartilhar tela'));
          }`;
      }
      if (nome === 'ScreenShareSourcePicker') {
        return `import React from 'react';
          export default function ScreenShareSourcePicker() {
            return React.createElement('div', { 'data-screen-share-picker': 'true' });
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
    ssr: { noExternal: ['socket.io-client'] },
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

function prepararAplicacao({ comSessao = true, busca = '' } = {}) {
  const fila = new Map();
  const sessao = JSON.stringify({
    token: 'token-teste',
    usuario: { id: 'user-1', nome: 'Jogador', status: 'online' },
  });
  const armazenamento = {
    getItem: (chave) => chave === 'sessao' && comSessao ? sessao : null,
    setItem() {},
    removeItem() {},
  };
  globalThis.localStorage = armazenamento;
  globalThis.window = new EventTarget();
  globalThis.window.location = { search: busca, href: 'https://astralis.test/' };
  globalThis.window.history = { replaceState() {} };
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

test('abre o lobby de salas enquanto carrega dados auxiliares da sessão', async () => {
  prepararAplicacao();
  await renderizar();

  assert.ok(chamadasFetch.includes('/api/servidores'));
  assert.equal(raiz.root.findByProps({ 'data-room-lobby': 'true' }).props['data-room-user'], 'Jogador');
  assert.equal(raiz.root.findAllByType('nav').length, 0);
});

test('mantém o lobby acessível se a lista antiga de servidores falhar', async () => {
  const api = prepararAplicacao();
  await renderizar();
  await act(async () => api.rejeitar('/api/servidores', 503, 'Servidor indisponível'));
  assert.equal(raiz.root.findAllByProps({ 'data-room-lobby': 'true' }).length, 1);
  assert.equal(raiz.root.findAllByType('nav').length, 0);
});

test('abre uma sala por link no navegador sem exigir uma sessão', async () => {
  prepararAplicacao({ comSessao: false, busca: '?room=room-public' });
  await renderizar();
  const streamRoom = raiz.root.findByProps({ 'data-stream-room': 'room-public' });
  assert.equal(streamRoom.props['data-stream-role'], 'viewer');
  assert.equal(chamadasFetch.length, 0);
});

test('espectador sem conta consegue abrir o seletor para compartilhar tela', async () => {
  prepararAplicacao({ comSessao: false, busca: '?room=room-public' });
  await renderizar();
  await act(async () => raiz.root.findByProps({ 'data-request-share': 'true' }).props.onClick());
  assert.equal(raiz.root.findAllByProps({ 'data-screen-share-picker': 'true' }).length, 1);
});

test('entra na sala privada pelo código e reutiliza a entrada confirmada pelo servidor', async () => {
  prepararAplicacao({ comSessao: false });
  await renderizar();

  let entrada;
  await act(async () => {
    entrada = await raiz.root.findByProps({ 'data-enter-private-room': 'true' }).props.onClick();
  });

  assert.deepEqual(entrada, { ok: true });
  const streamRoom = raiz.root.findByProps({ 'data-stream-room': 'room-from-code' });
  assert.equal(streamRoom.props['data-stream-role'], 'viewer');
  assert.equal(streamRoom.props['data-stream-joined'], 'true');
});

test('sessão salva é descartada quando a API de servidores retorna 401', async () => {
  const api = prepararAplicacao();
  await renderizar();
  await act(async () => api.rejeitar('/api/servidores', 401, 'Sessão expirada'));
  assert.equal(raiz.root.findAllByProps({ 'data-room-lobby': 'true' }).length, 1);
  assert.ok(raiz.root.findAllByType('nav').length === 0);
});
