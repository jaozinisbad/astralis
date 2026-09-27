const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const { criarAutenticador } = require('../middleware/autenticar');

const segredoTeste = 'segredo-local-de-teste';

function chamarMiddleware(autenticar, authorization) {
  const req = { headers: { authorization } };
  const resposta = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let proximo = false;
  autenticar(req, resposta, () => { proximo = true; });
  return { req, resposta, get proximo() { return proximo; } };
}

test('token ausente retorna 401 sem buscar a versão', () => {
  let buscouVersao = false;
  const autenticar = criarAutenticador(async () => { buscouVersao = true; });
  const resultado = chamarMiddleware(autenticar, undefined);

  assert.equal(resultado.resposta.statusCode, 401);
  assert.deepEqual(resultado.resposta.body, { erro: 'Token não fornecido.' });
  assert.equal(resultado.proximo, false);
  assert.equal(buscouVersao, false);
});

test('token inválido retorna 401', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const resultado = chamarMiddleware(criarAutenticador(async () => null), 'Bearer token-invalido');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, 401);
    assert.deepEqual(resultado.resposta.body, { erro: 'Token inválido ou expirado.' });
    assert.equal(resultado.proximo, false);
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});

test('token expirado retorna 401', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const token = jwt.sign({ id: 'usuario-teste' }, segredoTeste, { expiresIn: -1 });
    const resultado = chamarMiddleware(criarAutenticador(async () => null), `Bearer ${token}`);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, 401);
    assert.deepEqual(resultado.resposta.body, { erro: 'Token inválido ou expirado.' });
    assert.equal(resultado.proximo, false);
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});

test('token válido com versão vigente segue para a rota e popula req.usuario', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const token = jwt.sign({ id: 'usuario-teste', versao_sessao: 3 }, segredoTeste);
    const resultado = chamarMiddleware(criarAutenticador(async (id) => {
      assert.equal(id, 'usuario-teste');
      return { versao_sessao: 3 };
    }), `Bearer ${token}`);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, null);
    assert.equal(resultado.proximo, true);
    assert.equal(resultado.req.usuario.id, 'usuario-teste');
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});

test('token antigo sem versão continua válido antes de uma redefinição', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const token = jwt.sign({ id: 'usuario-teste' }, segredoTeste);
    const resultado = chamarMiddleware(criarAutenticador(async () => ({ versao_sessao: 0 })), `Bearer ${token}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.proximo, true);
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});

test('token de versão antiga retorna 401', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const token = jwt.sign({ id: 'usuario-teste', versao_sessao: 2 }, segredoTeste);
    const resultado = chamarMiddleware(criarAutenticador(async () => ({ versao_sessao: 3 })), `Bearer ${token}`);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, 401);
    assert.deepEqual(resultado.resposta.body, { erro: 'Token inválido ou expirado.' });
    assert.equal(resultado.proximo, false);
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});
