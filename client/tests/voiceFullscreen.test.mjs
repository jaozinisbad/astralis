import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternarTelaCheia } from '../src/voiceFullscreen.mjs';

test('abre o vídeo no player nativo quando a tela cheia do elemento não existe', async () => {
  let chamadas = 0;
  const video = { webkitEnterFullscreen: () => { chamadas++; } };
  const elemento = { querySelector: () => video };
  assert.equal(await alternarTelaCheia(elemento, {}, false), false);
  assert.equal(chamadas, 1);
});

test('usa a ampliação da página se o player nativo recusar o vídeo ao vivo', async () => {
  const elemento = { querySelector: () => ({ webkitEnterFullscreen: () => { throw new Error('unavailable'); } }) };
  assert.equal(await alternarTelaCheia(elemento, {}, false), true);
});

test('usa a página inteira quando o navegador não suporta ou recusa tela cheia', async () => {
  assert.equal(await alternarTelaCheia({}, {}, false), true);
  assert.equal(await alternarTelaCheia({ requestFullscreen: async () => { throw new Error('denied'); } }, {}, false), true);
  assert.equal(await alternarTelaCheia({}, {}, true), false);
});

test('usa e fecha a tela cheia nativa quando disponível', async () => {
  let opened = 0, closed = 0;
  const element = { requestFullscreen: async () => { opened++; } };
  const doc = { fullscreenElement: null, exitFullscreen: async () => { closed++; } };
  assert.equal(await alternarTelaCheia(element, doc, false), false);
  doc.fullscreenElement = element;
  assert.equal(await alternarTelaCheia(element, doc, false), false);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});
