import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sincronizarReproducaoDasTelas } from '../src/audioTela.mjs';

test('o áudio da transmissão só toca enquanto ela está aberta', () => {
  const audios = { amiga: { muted: false }, outro: { muted: false } };
  const estado = { audioMudo: false, telasMutadas: new Set(), telaSelecionadaId: null };

  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, true);
  assert.equal(audios.outro.muted, true);

  estado.telaSelecionadaId = 'amiga';
  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, false);
  assert.equal(audios.outro.muted, true);

  estado.telaSelecionadaId = null;
  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, true);
});

test('silenciar a chamada ou uma transmissão mantém seu áudio desligado ao reabrir', () => {
  const audios = { amiga: { muted: false } };
  const estado = { audioMudo: false, telasMutadas: new Set(), telaSelecionadaId: 'amiga' };

  estado.telasMutadas.add('amiga');
  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, true);

  estado.telasMutadas.clear();
  estado.audioMudo = true;
  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, true);

  estado.audioMudo = false;
  sincronizarReproducaoDasTelas(audios, estado);
  assert.equal(audios.amiga.muted, false);
});
