import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const fetchOriginal = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
let vite;
let LoginScreen;
let renderer;
let chamadas;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });
  ({ default: LoginScreen } = await vite.ssrLoadModule('/src/components/LoginScreen.jsx'));
});

after(async () => {
  await vite?.close();
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount());
    renderer = null;
  }
  if (fetchOriginal) Object.defineProperty(globalThis, 'fetch', fetchOriginal);
  else delete globalThis.fetch;
});

function ambienteFetch({ erroLogin, respostaLogin } = {}) {
  chamadas = [];
  globalThis.fetch = async (url, options = {}) => {
    chamadas.push({ url: String(url), options });
    if (String(url).endsWith('/health')) return new Promise(() => {});
    if (erroLogin) throw erroLogin;
    return respostaLogin;
  };
}

async function montar(onAutenticado = () => {}) {
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(LoginScreen, { onAutenticado }));
    await Promise.resolve();
  });
}

function encontrarCampo(name) {
  return renderer.root.findByProps({ name });
}

async function enviarLogin() {
  await act(async () => {
    encontrarCampo('email').props.onChange({ target: { value: 'jogador@exemplo.com' } });
    encontrarCampo('password').props.onChange({ target: { value: 'senha-segura' } });
  });
  const form = renderer.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
}

test('faz um único GET /health ao montar e aborta a requisição ao desmontar', async () => {
  ambienteFetch();
  await montar();

  assert.equal(chamadas.length, 1);
  assert.match(chamadas[0].url, /\/health$/);
  assert.equal(chamadas[0].options.method, undefined);
  assert.ok(chamadas[0].options.signal instanceof AbortSignal);
  assert.equal(chamadas[0].options.signal.aborted, false);

  await act(async () => renderer.unmount());
  renderer = null;
  assert.equal(chamadas[0].options.signal.aborted, true);
  assert.equal(chamadas.length, 1);
});

test('POST de login bem-sucedido chama onAutenticado com token e usuário', async () => {
  ambienteFetch({ respostaLogin: {
    ok: true,
    json: async () => ({ token: 'token-teste', usuario: { id: 'u1', nome: 'Jogador' } }),
  } });
  const onAutenticado = (...dados) => recebidos.push(dados);
  const recebidos = [];
  await montar(onAutenticado);
  await enviarLogin();

  const login = chamadas.find(({ url }) => url.endsWith('/api/login'));
  assert.ok(login);
  assert.equal(login.options.method, 'POST');
  assert.deepEqual(JSON.parse(login.options.body), { email: 'jogador@exemplo.com', senha: 'senha-segura' });
  assert.deepEqual(recebidos, [['token-teste', { id: 'u1', nome: 'Jogador' }]]);
});

test('resposta de erro do login mostra a mensagem e não autentica', async () => {
  ambienteFetch({ respostaLogin: {
    ok: false,
    status: 401,
    json: async () => ({ erro: 'Credenciais inválidas.' }),
  } });
  let autenticado = false;
  await montar(() => { autenticado = true; });
  await enviarLogin();

  assert.equal(autenticado, false);
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /Credenciais inválidas/);
});

test('falha por timeout mostra mensagem amigável e não autentica', async () => {
  const erro = new Error('aborted');
  erro.name = 'AbortError';
  ambienteFetch({ erroLogin: erro });
  let autenticado = false;
  await montar(() => { autenticado = true; });
  await enviarLogin();

  assert.equal(autenticado, false);
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /demorou para responder/i);
});

test('erro de conexão mostra mensagem amigável e não autentica', async () => {
  ambienteFetch({ erroLogin: new TypeError('Failed to fetch') });
  let autenticado = false;
  await montar(() => { autenticado = true; });
  await enviarLogin();

  assert.equal(autenticado, false);
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /conectar ao servidor/i);
});

test('recuperação exige confirmação igual e envia o contrato correto sem autenticar', async () => {
  chamadas = [];
  globalThis.fetch = async (url, options = {}) => {
    chamadas.push({ url: String(url), options });
    if (String(url).endsWith('/health')) return new Promise(() => {});
    return { ok: true, json: async () => ({ ok: true }) };
  };
  let autenticado = false;
  await montar(() => { autenticado = true; });
  await act(async () => {
    encontrarCampo('email').props.onChange({ target: { value: 'jogador@exemplo.com' } });
    renderer.root.findAllByType('button').find((button) => button.children.join('') === 'Esqueceu a senha?').props.onClick();
  });

  assert.equal(renderer.root.findByType('h1').children.join(''), 'Recuperar senha');
  await act(async () => {
    encontrarCampo('codigo').props.onChange({ target: { value: 'SUPORTE-123' } });
    encontrarCampo('novaSenha').props.onChange({ target: { value: 'senha-nova' } });
    encontrarCampo('confirmarSenha').props.onChange({ target: { value: 'diferente' } });
  });
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /não coincidem/i);
  assert.equal(chamadas.some(({ url }) => url.endsWith('/api/redefinir-senha')), false);

  await act(async () => encontrarCampo('confirmarSenha').props.onChange({ target: { value: 'senha-nova' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const redefinicao = chamadas.find(({ url }) => url.endsWith('/api/redefinir-senha'));
  assert.ok(redefinicao);
  assert.equal(redefinicao.options.method, 'POST');
  assert.deepEqual(JSON.parse(redefinicao.options.body), {
    email: 'jogador@exemplo.com', codigo: 'SUPORTE-123', novaSenha: 'senha-nova',
  });
  assert.equal(autenticado, false);
  assert.equal(encontrarCampo('email').props.value, 'jogador@exemplo.com');
  assert.equal(renderer.root.findByType('h1').children.join(''), 'Entrar');
  assert.match(renderer.root.findByProps({ role: 'status' }).children.join(''), /Senha redefinida com sucesso/);
});
