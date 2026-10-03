import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let RoomLobby;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    appType: 'custom',
  });
  ({ default: RoomLobby } = await vite.ssrLoadModule('/src/components/RoomLobby.jsx'));
});

after(async () => {
  await vite?.close();
});

class SocketDeTeste {
  listeners = new Map();
  emits = [];

  on(evento, listener) {
    this.listeners.set(evento, listener);
  }

  off(evento, listener) {
    if (this.listeners.get(evento) === listener) this.listeners.delete(evento);
  }

  emit(...args) {
    this.emits.push(args);
  }
}

function props(overrides = {}) {
  return {
    socket: new SocketDeTeste(),
    onCriar: async () => ({ ok: true }),
    onEntrar: async () => ({ ok: true }),
    onAbrirPerfil() {},
    usuario: { nome: 'Luna' },
    ...overrides,
  };
}

async function montar(overrides = {}) {
  const configuracao = props(overrides);
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(RoomLobby, configuracao));
    await Promise.resolve();
  });
  return { renderer, configuracao };
}

function texto(renderer) {
  return renderer.root.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    .join(' ');
}

function botao(renderer, nome) {
  return renderer.root.findAllByType('button')
    .find((item) => item.children.filter((child) => typeof child === 'string').join('').trim().includes(nome));
}

test('lista salas pelo socket, atualiza a lista ao vivo e remove o listener ao desmontar', async () => {
  const socket = new SocketDeTeste();
  const { renderer } = await montar({ socket });

  assert.match(texto(renderer), /Buscando transmissões abertas/);
  assert.equal(socket.emits[0][0], 'salas:listar');
  assert.deepEqual(socket.emits[0][1], {});
  assert.equal(typeof socket.emits[0][2], 'function');
  assert.equal(socket.listeners.has('salas:atualizadas'), true);

  await act(async () => socket.emits[0][2]({
    ok: true,
    rooms: [{ id: 'room-1', name: 'Noite de jogos', ownerName: 'Luna', viewerCount: 2 }],
  }));
  assert.match(texto(renderer), /Noite de jogos/);
  assert.match(texto(renderer), /Luna/);

  await act(async () => botao(renderer, 'Atualizar salas').props.onClick());
  assert.equal(socket.emits[1][0], 'salas:listar');
  assert.deepEqual(socket.emits[1][1], {});
  await act(async () => socket.emits[1][2]({ ok: true, rooms: [] }));

  await act(async () => socket.listeners.get('salas:atualizadas')({
    rooms: [{ id: 'room-2', name: 'Gameplay ao vivo', ownerName: 'Kai', viewerCount: 1 }],
  }));
  assert.match(texto(renderer), /Gameplay ao vivo/);
  assert.doesNotMatch(texto(renderer), /Noite de jogos/);

  await act(async () => renderer.unmount());
  assert.equal(socket.listeners.has('salas:atualizadas'), false);
});

test('mostra estado vazio depois de uma listagem bem-sucedida sem salas públicas', async () => {
  const socket = new SocketDeTeste();
  const { renderer } = await montar({ socket });

  await act(async () => socket.emits[0][2]({ ok: true, rooms: [] }));

  assert.match(texto(renderer), /Nenhuma sala pública ao vivo/);
  assert.ok(botao(renderer, 'Atualizar lista'));
});

test('mostra erro de listagem recebido pelo callback do socket', async () => {
  const socket = new SocketDeTeste();
  const { renderer } = await montar({ socket });

  await act(async () => socket.emits[0][2]({ ok: false, error: 'Falha ao buscar salas.' }));

  assert.match(texto(renderer), /Falha ao buscar salas\./);
  assert.ok(botao(renderer, 'Tentar novamente'));
});

test('submete nome e visibilidade escolhidos ao callback de criação', async () => {
  const criar = [];
  const { renderer } = await montar({ onCriar: async (dados) => { criar.push(dados); return { ok: true }; } });

  await act(async () => {
    renderer.root.findByProps({ 'aria-label': 'Nome da sala' }).props.onChange({ target: { value: '  Sessão cooperativa  ' } });
  });
  await act(async () => {
    renderer.root.findByProps({ value: 'private' }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.deepEqual(criar, [{ name: 'Sessão cooperativa', visibility: 'private' }]);
});

test('abre o modal de acesso privado e encaminha id e código ao callback de entrada', async () => {
  const entradas = [];
  const { renderer } = await montar({ onEntrar: async (dados) => { entradas.push(dados); return { ok: true }; } });

  await act(async () => botao(renderer, 'Entrar com código').props.onClick());
  assert.ok(renderer.root.findByProps({ role: 'dialog' }));

  await act(async () => {
    renderer.root.findByProps({ 'aria-label': 'ID da sala privada' }).props.onChange({ target: { value: 'room-private' } });
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': 'Código de acesso' }).props.onChange({ target: { value: 'ABCD2345' } });
  });
  await act(async () => {
    renderer.root.findByProps({ role: 'dialog' }).findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.deepEqual(entradas, [{ roomId: 'room-private', accessCode: 'ABCD2345' }]);
});

test('entra em sala pública sem pedir código privado', async () => {
  const entradas = [];
  const socket = new SocketDeTeste();
  const { renderer } = await montar({ socket, onEntrar: async (dados) => { entradas.push(dados); return { ok: true }; } });
  await act(async () => socket.emits[0][2]({
    ok: true,
    rooms: [{ id: 'public-1', name: 'Partida aberta', ownerName: 'Nix', viewerCount: 0 }],
  }));

  await act(async () => botao(renderer, 'Assistir').props.onClick());

  assert.deepEqual(entradas, [{ roomId: 'public-1', accessCode: '' }]);
});
