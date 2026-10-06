import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let apiFetch;

before(async () => {
  vite = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  ({ apiFetch } = await vite.ssrLoadModule('/src/api.js'));
});

after(async () => {
  await vite?.close();
});

function prepararAmbiente({ resposta, erroRede } = {}) {
  const removidos = [];
  const eventos = [];
  globalThis.localStorage = { removeItem: (chave) => removidos.push(chave) };
  globalThis.window = { dispatchEvent: (evento) => eventos.push(evento.type) };
  globalThis.fetch = erroRede
    ? async () => { throw erroRede; }
    : async () => ({
      ok: resposta.status >= 200 && resposta.status < 300,
      status: resposta.status,
      json: async () => resposta.dados || {},
    });
  return { removidos, eventos };
}

test('403 de permissão preserva a sessão', async () => {
  const estado = prepararAmbiente({ resposta: { status: 403, dados: { erro: 'Sem permissão.' } } });

  await assert.rejects(apiFetch('/privado', 'token-valido'), (erro) => {
    assert.equal(erro.status, 403);
    assert.equal(erro.message, 'Sem permissão.');
    return true;
  });
  assert.deepEqual(estado.removidos, []);
  assert.deepEqual(estado.eventos, []);
});

test('401 em requisição autenticada limpa a sessão e emite o evento', async () => {
  const estado = prepararAmbiente({ resposta: { status: 401, dados: { erro: 'Token inválido ou expirado.' } } });

  await assert.rejects(apiFetch('/privado', 'token-expirado'), { status: 401 });
  assert.deepEqual(estado.removidos, ['sessao']);
  assert.deepEqual(estado.eventos, ['sessao-invalida']);
});

test('401 no login sem token não limpa a sessão existente', async () => {
  const estado = prepararAmbiente({ resposta: { status: 401, dados: { erro: 'Credenciais inválidas.' } } });

  await assert.rejects(apiFetch('/login', null), { status: 401 });
  assert.deepEqual(estado.removidos, []);
  assert.deepEqual(estado.eventos, []);
});

test('403 de token expirado no backend antigo ainda invalida a sessão', async () => {
  const estado = prepararAmbiente({ resposta: { status: 403, dados: { erro: 'Token inválido ou expirado.' } } });
  await assert.rejects(apiFetch('/privado', 'token-expirado'), { status: 403 });
  assert.deepEqual(estado.removidos, ['sessao']);
  assert.deepEqual(estado.eventos, ['sessao-invalida']);
});

test('403 sem mensagem não é apresentado como sessão expirada', async () => {
  const estado = prepararAmbiente({ resposta: { status: 403 } });
  await assert.rejects(apiFetch('/privado', 'token-valido'), /não tem permissão/);
  assert.deepEqual(estado.removidos, []);
});

test('resposta de sucesso é retornada sem invalidar sessão', async () => {
  const estado = prepararAmbiente({ resposta: { status: 200, dados: { ok: true } } });

  assert.deepEqual(await apiFetch('/dados', 'token-valido'), { ok: true });
  assert.deepEqual(estado.removidos, []);
  assert.deepEqual(estado.eventos, []);
});

test('erro de rede não limpa sessão', async () => {
  const estado = prepararAmbiente({ erroRede: new Error('offline') });

  await assert.rejects(apiFetch('/dados', 'token-valido'), /offline/);
  assert.deepEqual(estado.removidos, []);
  assert.deepEqual(estado.eventos, []);
});
