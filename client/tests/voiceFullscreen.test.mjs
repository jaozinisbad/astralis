import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternarTelaCheia } from '../src/voiceFullscreen.mjs';

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
