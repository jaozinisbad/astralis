import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const originalWindow = globalThis.window;
let vite; let Component; let AddServerModal; let ProfileModal; let rendered;
before(async () => {
  vite = await createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { optimizeDeps: { noDiscovery: true, include: [] } }, appType: 'custom' });
  ({ default: Component } = await vite.ssrLoadModule('/src/components/ServerSettingsModal.jsx'));
  ({ default: AddServerModal } = await vite.ssrLoadModule('/src/components/AddServerModal.jsx'));
  ({ default: ProfileModal } = await vite.ssrLoadModule('/src/components/ProfileModal.jsx'));
});
after(async () => { await vite?.close(); });
afterEach(() => { act(() => rendered?.unmount()); rendered = undefined; globalThis.window = originalWindow; });
function props(overrides = {}) {
  return { servidor: { id: 1, nome: 'Orbital', descricao: 'Comunidade', icone_url: 'data:image/png;base64,AA', banner_url: 'data:image/png;base64,BB' },
    cargos: [{ id: 10, nome: 'Administrador', cor: '#ff0000' }, { id: 11, nome: 'Equipe', cor: '#9270f4' }],
    membros: [{ id: 1, nome: 'Luna', papel: 'dono', cargos: [{ id: 10, nome: 'Administrador', cor: '#ff0000' }] }, { id: 2, nome: 'Sol', papel: 'membro', cargos: [{ id: 11, nome: 'Equipe', cor: '#9270f4' }] }],
    onFechar() {}, onSalvar: async () => {}, onCriarCargo: async () => {}, onAtribuirCargo: async () => {}, ...overrides };
}
function mount(overrides = {}) { globalThis.window = { confirm: () => true }; act(() => { rendered = TestRenderer.create(React.createElement(Component, props(overrides))); }); return rendered.root; }
function button(tree, text) { return tree.findAllByType('button').find((item) => item.props.children === text || Array.isArray(item.props.children) && item.props.children[0] === text); }
function selectTab(tree, text) { act(() => button(tree, text).props.onClick()); }
const submit = (tree) => act(async () => { await tree.findByType('form').props.onSubmit({ preventDefault() {} }); });

test('configurações têm navegação separada para visão geral, cargos e membros', () => {
  const markup = renderToStaticMarkup(React.createElement(Component, props()));
  assert.match(markup, /role="dialog" aria-modal="true"/);
  assert.match(markup, /aria-label="Configurações do servidor"/);
  assert.match(markup, /aria-current="page">Visão geral/);
  assert.match(markup, /Enviar ícone do servidor/);
  assert.match(markup, /Enviar banner do servidor/);
  assert.equal(markup.includes('Criar cargo'), false);
  assert.equal(markup.includes('Buscar membros'), false);
});

test('salvar visão geral preserva imagens e envia nome e descrição normalizados', async () => {
  const calls = []; const tree = mount({ onSalvar: async (data) => calls.push(data) });
  act(() => tree.findAllByType('input').find((item) => item.props.maxLength === 80).props.onChange({ target: { value: '  Nova Orbital ' } }));
  act(() => tree.findByType('textarea').props.onChange({ target: { value: '  Amigos  ' } }));
  await submit(tree);
  assert.deepEqual(calls, [{ nome: 'Nova Orbital', descricao: 'Amigos', icone_url: 'data:image/png;base64,AA', banner_url: 'data:image/png;base64,BB' }]);
  assert.equal(tree.findByProps({ role: 'status' }).props.children, 'Servidor salvo.');
});

test('redefinir restaura os dados e remoção de imagem é enviada como null', async () => {
  const calls = []; const tree = mount({ onSalvar: async (data) => calls.push(data) });
  act(() => button(tree, 'Remover ícone').props.onClick());
  act(() => button(tree, 'Remover banner').props.onClick());
  await submit(tree);
  assert.equal(calls[0].icone_url, null); assert.equal(calls[0].banner_url, null);
  act(() => button(tree, 'Redefinir').props.onClick());
  assert.equal(tree.findByProps({ alt: 'Ícone de Orbital' }).props.src, 'data:image/png;base64,AA');
});

test('criar cargo mantém o contrato de cor e permissões', async () => {
  const calls = []; const tree = mount({ onCriarCargo: async (data) => calls.push(data) });
  selectTab(tree, 'Cargos');
  act(() => tree.findByProps({ placeholder: 'Novo cargo' }).props.onChange({ target: { value: '  Moderador  ' } }));
  act(() => tree.findByProps({ 'aria-label': 'Gerenciar canais' }).props.onChange({ target: { checked: true } }));
  act(() => tree.findByProps({ type: 'color' }).props.onChange({ target: { value: '#ff00ff' } }));
  await submit(tree);
  assert.deepEqual(calls, [{ nome: 'Moderador', cor: '#ff00ff', permissoes: { gerenciar_canais: true } }]);
  assert.equal(tree.findByProps({ placeholder: 'Novo cargo' }).props.value, '');
});

test('atribuição exclui proprietário e cargo Administrador das opções', async () => {
  const calls = []; const tree = mount({ onAtribuirCargo: async (...data) => calls.push(data) }); selectTab(tree, 'Membros');
  const selects = tree.findAllByType('select');
  assert.deepEqual(selects[0].findAllByType('option').map((option) => option.props.value), ['', 2]);
  assert.deepEqual(selects[1].findAllByType('option').map((option) => option.props.value), ['', 11]);
  act(() => selects[0].props.onChange({ target: { value: '2' } }));
  act(() => selects[1].props.onChange({ target: { value: '11' } }));
  await submit(tree); assert.deepEqual(calls, [[2, 11]]);
  await act(async () => tree.findByProps({ 'aria-label': 'Remover cargo Equipe de Sol' }).props.onClick());
  assert.deepEqual(calls, [[2, 11], [2, 11, true]]);
  assert.equal(tree.findAllByProps({ 'aria-label': 'Remover cargo Administrador de Luna' }).length, 0);
});

test('moderação respeita confirmação e erros de API são exibidos', async () => {
  const expelled = []; const tree = mount({ onExpulsarMembro: async (id) => expelled.push(id), onBanir: async () => { throw new Error('Sem permissão para banir.'); } }); selectTab(tree, 'Membros');
  assert.equal(tree.findAllByType('button').filter((item) => item.props.children === 'Expulsar').length, 1);
  globalThis.window.confirm = () => false;
  await act(async () => button(tree, 'Expulsar').props.onClick()); assert.deepEqual(expelled, []);
  globalThis.window.confirm = () => true;
  await act(async () => button(tree, 'Expulsar').props.onClick()); assert.deepEqual(expelled, [2]);
  await act(async () => button(tree, 'Banir').props.onClick());
  assert.equal(tree.findByProps({ role: 'alert' }).props.children, 'Sem permissão para banir.');
});

test('upload inválido não inicia conversão e apresenta orientação', async () => {
  const tree = mount();
  await act(async () => tree.findByProps({ 'aria-label': 'Enviar ícone do servidor' }).props.onChange({ target: { files: [{ type: 'application/pdf', size: 123 }], value: 'fake' } }));
  assert.equal(tree.findByProps({ role: 'alert' }).props.children, 'Use uma imagem de até 5MB.');
});

test('busca de membros filtra a lista sem alterar opções de atribuição', () => {
  const tree = mount(); selectTab(tree, 'Membros');
  act(() => tree.findByProps({ 'aria-label': 'Buscar membros' }).props.onChange({ target: { value: 'luNA' } }));
  assert.equal(tree.findAllByType('article').length, 1);
  assert.equal(tree.findAllByType('select')[0].findAllByType('option').length, 2);
});

test('perfil e criação de servidor têm semântica de diálogo e controles nativos', () => {
  const add = renderToStaticMarkup(React.createElement(AddServerModal, { onFechar() {}, onCriar() {}, onEntrar() {} }));
  assert.match(add, /role="dialog" aria-modal="true" aria-label="Criar ou entrar em servidor"/);
  assert.match(add, /<button[^>]+aria-pressed="true"/);
  assert.match(add, /aria-label="Nome do servidor"/);
  const profile = renderToStaticMarkup(React.createElement(ProfileModal, { usuario: { nome: 'Luna' }, onFechar() {}, onSalvar() {} }));
  assert.match(profile, /role="dialog" aria-modal="true" aria-labelledby="astralis-profile-title"/);
  assert.match(profile, /id="astralis-profile-title"/);
});
