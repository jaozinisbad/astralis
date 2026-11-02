import assert from 'node:assert/strict';
import { after, before, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originais = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
let vite;
let AtualizacaoBanner;
let App;
let arvore;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    plugins: [{
      name: 'update-ui-app-stubs',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'socket.io-client') return '\0update-ui-socket';
        const componente = id.match(/^\.\/components\/(.+)\.jsx$/);
        return componente && componente[1] !== 'AtualizacaoBanner' ? '\0update-ui-component:' + componente[1] : null;
      },
      load(id) {
        if (id === '\0update-ui-socket') return 'export const io = () => ({ on() {}, off() {}, once() {}, emit() {}, disconnect() {} });';
        if (!id.startsWith('\0update-ui-component:')) return null;
        const nome = id.split(':')[1];
        if (nome === 'RoomLobby') return "import React from 'react'; export default function RoomLobby(props) { return React.createElement('button', { onClick: props.onEntrarNaConta, 'data-test-screen': 'lobby' }, 'Entrar na conta'); }";
        return "import React from 'react'; export default function Componente() { return React.createElement('div', { 'data-test-screen': '" + nome + "' }); }";
      },
    }],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ default: AtualizacaoBanner } = await vite.ssrLoadModule('/src/components/AtualizacaoBanner.jsx'));
  ({ default: App } = await vite.ssrLoadModule('/src/App.jsx'));
});

after(async () => vite?.close());
afterEach(async () => {
  if (arvore) await act(async () => arvore.unmount());
  arvore = null;
  Object.assign(globalThis, originais);
});

function adiar() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function preparar(estado, overrides = {}) {
  const chamadas = { check: 0, download: 0, install: 0, removidos: 0 };
  let listener;
  globalThis.window = new EventTarget();
  globalThis.window.location = { search: '', href: 'https://astralis.test/' };
  globalThis.window.history = { replaceState() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  globalThis.window.electronAPI = {
    obterStatusAtualizacao: async () => estado,
    onAtualizacaoStatus(callback) {
      listener = callback;
      return () => { listener = undefined; chamadas.removidos += 1; };
    },
    async verificarAtualizacao() { chamadas.check += 1; return estado; },
    async baixarAtualizacao() { chamadas.download += 1; return estado; },
    async reiniciarParaAtualizar() { chamadas.install += 1; return estado; },
    ...overrides,
  };
  return { chamadas, emitir: (proximo) => listener?.(proximo) };
}

async function montar(Componente = AtualizacaoBanner) {
  await act(async () => { arvore = TestRenderer.create(React.createElement(Componente)); });
}

function botao(rotulo) {
  return arvore.root.findAllByType('button').find((node) => node.children.join('') === rotulo);
}

function texto() {
  return arvore.root.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ');
}

test('navegador sem bridge não mostra controles nem dispara ações', async () => {
  preparar();
  globalThis.window.electronAPI = undefined;
  await montar();
  assert.equal(arvore.toJSON(), null);
});

test('detecção apenas avisa; download e instalação dependem dos respectivos cliques', async () => {
  const download = adiar();
  const install = adiar();
  const api = preparar({ status: 'available', version: '1.6.0', revision: 1 });
  globalThis.window.electronAPI.baixarAtualizacao = () => { api.chamadas.download += 1; return download.promise; };
  globalThis.window.electronAPI.reiniciarParaAtualizar = () => { api.chamadas.install += 1; return install.promise; };
  await montar();
  assert.match(texto(), /1.6.0 disponível/);
  assert.deepEqual([api.chamadas.check, api.chamadas.download, api.chamadas.install], [0, 0, 0]);

  const clicarDownload = botao('Baixar atualização').props.onClick;
  await act(async () => { clicarDownload(); clicarDownload(); });
  assert.equal(api.chamadas.download, 1);
  assert.equal(botao('Iniciando download…').props.disabled, true);
  await act(async () => api.emitir({ status: 'downloading', percent: 42.9, revision: 2 }));
  assert.equal(arvore.root.findByType('progress').props.value, 42);
  assert.equal(botao('Reiniciar e instalar'), undefined);

  await act(async () => {
    api.emitir({ status: 'downloaded', version: '1.6.0', revision: 4 });
    download.resolve({ status: 'downloading', percent: 20, revision: 3 });
  });
  assert.match(texto(), /Fechar o Astralis não instala/);
  assert.equal(api.chamadas.install, 0);
  const clicarInstall = botao('Reiniciar e instalar').props.onClick;
  await act(async () => { clicarInstall(); clicarInstall(); });
  assert.equal(api.chamadas.install, 1);
  assert.equal(botao('Reiniciando…').props.disabled, true);
  await act(async () => install.resolve({ status: 'installing', version: '1.6.0', revision: 5 }));
  assert.equal(botao('Reiniciar e instalar'), undefined);
  assert.match(texto(), /Reiniciando para instalar/);
});

test('adiar mantém aviso acessível e não inicia download nem instalação', async () => {
  const api = preparar({ status: 'available', version: '1.6.0', revision: 1 });
  await montar();
  await act(async () => botao('Mais tarde').props.onClick());
  assert.equal(botao('Baixar atualização'), undefined);
  assert.ok(botao('Ver atualização'));
  await act(async () => api.emitir({ status: 'downloaded', version: '1.6.0', revision: 2 }));
  assert.match(texto(), /1.6.0 pronta/);
  assert.equal(botao('Reiniciar e instalar'), undefined);
  assert.deepEqual([api.chamadas.download, api.chamadas.install], [0, 0]);
  await act(async () => botao('Ver atualização').props.onClick());
  assert.ok(botao('Reiniciar e instalar'));
});

test('erro de download repete download e não confunde com uma nova verificação', async () => {
  const api = preparar({ status: 'error', errorStage: 'download', version: '1.6.0', message: 'Download interrompido.', revision: 3 });
  await montar();
  await act(async () => botao('Tentar baixar novamente').props.onClick());
  assert.deepEqual([api.chamadas.check, api.chamadas.download, api.chamadas.install], [0, 1, 0]);
});

test('erro de verificação consulta novamente sem baixar; erro de instalação oferece reiniciar', async () => {
  const api = preparar({ status: 'error', errorStage: 'check', message: 'Sem conexão.', revision: 1 });
  await montar();
  await act(async () => botao('Tentar novamente').props.onClick());
  assert.deepEqual([api.chamadas.check, api.chamadas.download, api.chamadas.install], [1, 0, 0]);
  await act(async () => api.emitir({ status: 'error', errorStage: 'install', version: '1.6.0', revision: 2 }));
  await act(async () => botao('Reiniciar e instalar').props.onClick());
  assert.equal(api.chamadas.install, 1);
});

test('rejeição do IPC de download apresenta erro e deixa repetir por clique', async () => {
  const api = preparar({ status: 'available', version: '1.6.0', revision: 1 });
  globalThis.window.electronAPI.baixarAtualizacao = async () => { api.chamadas.download += 1; throw new Error('IPC indisponível'); };
  await montar();
  await act(async () => botao('Baixar atualização').props.onClick());
  assert.match(texto(), /Não foi possível baixar/);
  assert.equal(api.chamadas.download, 1);
  await act(async () => botao('Tentar baixar novamente').props.onClick());
  assert.equal(api.chamadas.download, 2);
  assert.equal(api.chamadas.install, 0);
});

test('snapshot atrasado e eventos antigos não substituem estado mais recente', async () => {
  const snapshot = adiar();
  const api = preparar(null, { obterStatusAtualizacao: () => snapshot.promise });
  await montar();
  await act(async () => api.emitir({ status: 'downloaded', version: '1.6.0', revision: 6 }));
  await act(async () => snapshot.resolve({ status: 'available', version: '1.6.0', revision: 1 }));
  await act(async () => api.emitir({ status: 'downloading', percent: 12, revision: 3 }));
  assert.match(texto(), /1.6.0 pronta/);
  assert.ok(botao('Reiniciar e instalar'));
  assert.equal(api.chamadas.download, 0);
});

test('falha na consulta inicial é recuperável e listener é removido ao sair', async () => {
  const api = preparar(null, { obterStatusAtualizacao: async () => { throw new Error('IPC'); } });
  await montar();
  assert.match(texto(), /Não foi possível consultar/);
  await act(async () => botao('Tentar novamente').props.onClick());
  assert.equal(api.chamadas.check, 1);
  await act(async () => arvore.unmount());
  arvore = null;
  assert.equal(api.chamadas.removidos, 1);
});

test('ações encerradas após desmontagem não deixam listener ativo', async () => {
  const download = adiar();
  const api = preparar({ status: 'available', revision: 1 }, { baixarAtualizacao: () => download.promise });
  await montar();
  await act(async () => { botao('Baixar atualização').props.onClick(); });
  await act(async () => arvore.unmount());
  arvore = null;
  await act(async () => download.reject(new Error('Tarde demais')));
  assert.equal(api.chamadas.removidos, 1);
});

test('aviso global permanece no lobby, na sala, no login e com sessão autenticada', async () => {
  for (const comSessao of [false, true]) {
    for (const busca of ['', '?room=sala-teste']) {
      preparar({ status: 'available', version: '1.6.0', revision: 1 });
      globalThis.window.location.search = busca;
      if (comSessao) globalThis.localStorage.getItem = (chave) => chave === 'sessao'
        ? JSON.stringify({ token: 'teste', usuario: { id: 'user-1', nome: 'Jogador' } }) : null;
      await montar(App);
      assert.equal(arvore.root.findAllByProps({ 'aria-label': 'Atualização do Astralis' }).length, 1);
      assert.ok(botao('Baixar atualização'));
      if (!comSessao && !busca) {
        await act(async () => botao('Entrar na conta').props.onClick());
        assert.equal(arvore.root.findAllByProps({ 'data-test-screen': 'LoginScreen' }).length, 1);
        assert.ok(botao('Baixar atualização'));
      }
      await act(async () => arvore.unmount());
      arvore = null;
    }
  }
});

test('rejeição do IPC de instalação mantém opção explícita para tentar reiniciar', async () => {
  const api = preparar({ status: 'downloaded', version: '1.6.0', revision: 4 });
  globalThis.window.electronAPI.reiniciarParaAtualizar = async () => { api.chamadas.install += 1; throw new Error('IPC falhou'); };
  await montar();
  await act(async () => botao('Reiniciar e instalar').props.onClick());
  assert.match(texto(), /Não foi possível reiniciar para instalar/);
  assert.ok(botao('Reiniciar e instalar'));
  assert.equal(api.chamadas.install, 1);
  assert.equal(api.chamadas.download, 0);
});

test('rejeição tardia de download não esconde pacote já pronto recebido por evento', async () => {
  const download = adiar();
  const api = preparar({ status: 'available', revision: 1 }, { baixarAtualizacao: () => download.promise });
  await montar();
  await act(async () => { botao('Baixar atualização').props.onClick(); });
  await act(async () => {
    api.emitir({ status: 'downloaded', version: '1.6.0', revision: 4 });
    download.reject(new Error('Resposta antiga'));
  });
  assert.ok(botao('Reiniciar e instalar'));
  assert.match(texto(), /1.6.0 pronta/);
  assert.equal(api.chamadas.install, 0);
});

test('atualizar o aviso e adiar preservam sessão salva e a tela já montada', async () => {
  const api = preparar({ status: 'available', version: '1.6.0', revision: 1 });
  const sessao = JSON.stringify({ token: 'token-preservado', usuario: { id: 'user-1', nome: 'Jogador' } });
  const gravacoes = { set: 0, remove: 0 };
  const armazenamento = new Map([['sessao', sessao], ['preferencias', 'preservadas']]);
  globalThis.localStorage = {
    getItem: (chave) => armazenamento.get(chave) ?? null,
    setItem: (chave, valor) => { gravacoes.set += 1; armazenamento.set(chave, valor); },
    removeItem: (chave) => { gravacoes.remove += 1; armazenamento.delete(chave); },
  };
  await montar(App);
  const lobby = arvore.root.findByProps({ 'data-test-screen': 'lobby' });
  await act(async () => botao('Mais tarde').props.onClick());
  await act(async () => api.emitir({ status: 'downloading', version: '1.6.0', percent: 65, revision: 2 }));
  await act(async () => api.emitir({ status: 'downloaded', version: '1.6.0', revision: 3 }));
  assert.equal(arvore.root.findByProps({ 'data-test-screen': 'lobby' }), lobby);
  assert.equal(armazenamento.get('sessao'), sessao);
  assert.equal(armazenamento.get('preferencias'), 'preservadas');
  assert.deepEqual(gravacoes, { set: 0, remove: 0 });
  assert.deepEqual([api.chamadas.download, api.chamadas.install], [0, 0]);
  assert.ok(botao('Ver atualização'));
});