const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const { criarRouterRecuperacao } = require('../routes/recuperacao');

const codigoValido = 'codigo-de-recuperacao-seguro';
const emailPrivado = 'jogador@example.test';
const erroCodigo = { erro: 'Código inválido ou expirado. Peça outro código ao suporte.' };

function hashCodigo(codigo) {
  return crypto.createHash('sha256').update(codigo).digest('hex');
}

async function iniciarServidor(opcoes = {}) {
  const estado = {
    existe: opcoes.existe ?? true,
    expirado: opcoes.expirado ?? false,
    emailArmazenado: opcoes.emailArmazenado ?? emailPrivado,
    codigoHash: hashCodigo(codigoValido),
    consumido: false,
    usuarioVersao: 4,
    senhaHash: null,
    chamadas: 0,
    redefinicoes: [],
  };

  async function executar(sql, parametros) {
    estado.chamadas += 1;
    if (sql.includes('SELECT r.codigo_hash')) {
      const [email] = parametros;
      if (!estado.existe || estado.expirado || estado.consumido ||
          email.trim() !== estado.emailArmazenado.trim()) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ codigo_hash: estado.codigoHash }], rowCount: 1 };
    }

    assert.match(sql, /DELETE FROM recuperacoes_senha/);
    const [email, codigoHashInformado, senhaHash] = parametros;
    if (email.trim() !== estado.emailArmazenado.trim() || !estado.existe || estado.expirado ||
        estado.consumido || codigoHashInformado !== estado.codigoHash) {
      return { rows: [], rowCount: 0 };
    }
    estado.consumido = true;
    estado.usuarioVersao += 1;
    estado.senhaHash = senhaHash;
    return { rows: [{ id: 'usuario-1', versao_sessao: estado.usuarioVersao }], rowCount: 1 };
  }

  const app = express();
  app.use(express.json());
  app.use(criarRouterRecuperacao({
    executar,
    hashSenha: async (senha) => `hash:${senha}`,
    aoRedefinir: (id, versaoSessao) => estado.redefinicoes.push([id, versaoSessao]),
  }));
  app.use((erro, req, res, next) => {
    void erro;
    void next;
    res.status(500).json({ erro: 'Falha interna.' });
  });
  const servidor = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  return {
    estado,
    fechar: () => new Promise((resolve, reject) => servidor.close((erro) => erro ? reject(erro) : resolve())),
    requisitar: (body) => fetch(`http://127.0.0.1:${servidor.address().port}/redefinir-senha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const dadosValidos = (sobrescritos = {}) => ({
  email: emailPrivado,
  codigo: codigoValido,
  novaSenha: 'senha-nova-segura',
  ...sobrescritos,
});

test('entrada inválida retorna 400 sem consultar o banco', async (t) => {
  const servidor = await iniciarServidor();
  t.after(() => servidor.fechar());

  for (const body of [
    {},
    dadosValidos({ novaSenha: 'curta' }),
    dadosValidos({ email: 'x'.repeat(255) }),
    dadosValidos({ codigo: 'x'.repeat(201) }),
  ]) {
    const resposta = await servidor.requisitar(body);
    assert.equal(resposta.status, 400);
    assert.match((await resposta.json()).erro, /e-mail, código e uma nova senha/);
    assert.equal(resposta.headers.get('cache-control'), 'no-store');
  }
  assert.equal(servidor.estado.chamadas, 0);
});

test('código incorreto retorna erro genérico sem revelar o e-mail nem invalidar o correto', async (t) => {
  const servidor = await iniciarServidor();
  t.after(() => servidor.fechar());

  const resposta = await servidor.requisitar(dadosValidos({ codigo: 'incorreto' }));
  const corpo = await resposta.json();
  assert.equal(resposta.status, 400);
  assert.deepEqual(corpo, erroCodigo);
  assert.equal(JSON.stringify(corpo).includes(emailPrivado), false);

  const correta = await servidor.requisitar(dadosValidos());
  assert.equal(correta.status, 200);
  assert.deepEqual(await correta.json(), { mensagem: 'Senha redefinida. Entre com a nova senha.' });
  assert.equal(servidor.estado.consumido, true);
});

test('recupera conta cujo e-mail armazenado tem espaços nas pontas', async (t) => {
  const servidor = await iniciarServidor({ emailArmazenado: `  ${emailPrivado}  ` });
  t.after(() => servidor.fechar());

  const resposta = await servidor.requisitar(dadosValidos());
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { mensagem: 'Senha redefinida. Entre com a nova senha.' });
  assert.equal(servidor.estado.consumido, true);
});

test('código expirado e ausência de registro retornam a mesma resposta genérica', async (t) => {
  const respostas = [];
  for (const opcoes of [{ expirado: true }, { existe: false }]) {
    const servidor = await iniciarServidor(opcoes);
    t.after(() => servidor.fechar());
    const resposta = await servidor.requisitar(dadosValidos());
    respostas.push({ status: resposta.status, corpo: await resposta.json() });
  }

  assert.deepEqual(respostas, [
    { status: 400, corpo: erroCodigo },
    { status: 400, corpo: erroCodigo },
  ]);
  assert.equal(JSON.stringify(respostas).includes(emailPrivado), false);
});

test('limita a 30 tentativas por IP na janela', async (t) => {
  const servidor = await iniciarServidor({ existe: false });
  t.after(() => servidor.fechar());

  for (let tentativa = 0; tentativa < 30; tentativa += 1) {
    const resposta = await servidor.requisitar(dadosValidos({ codigo: 'incorreto' }));
    assert.equal(resposta.status, 400);
    assert.deepEqual(await resposta.json(), erroCodigo);
  }
  const bloqueada = await servidor.requisitar(dadosValidos({ codigo: 'incorreto' }));
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), {
    erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
  });
  assert.equal(servidor.estado.chamadas, 30);
});

test('redefine uma vez e rejeita a reutilização do código', async (t) => {
  const servidor = await iniciarServidor();
  t.after(() => servidor.fechar());

  const primeira = await servidor.requisitar(dadosValidos());
  assert.equal(primeira.status, 200);
  assert.deepEqual(await primeira.json(), { mensagem: 'Senha redefinida. Entre com a nova senha.' });
  assert.equal(primeira.headers.get('cache-control'), 'no-store');
  assert.equal(servidor.estado.senhaHash, 'hash:senha-nova-segura');
  assert.equal(servidor.estado.usuarioVersao, 5);
  assert.deepEqual(servidor.estado.redefinicoes, [['usuario-1', 5]]);

  const segunda = await servidor.requisitar(dadosValidos());
  assert.equal(segunda.status, 400);
  assert.deepEqual(await segunda.json(), erroCodigo);
  assert.equal(servidor.estado.usuarioVersao, 5);
  assert.deepEqual(servidor.estado.redefinicoes, [['usuario-1', 5]]);
});
