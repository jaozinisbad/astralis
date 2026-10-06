const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const autenticar = require('../middleware/autenticar');

const segredoTeste = 'segredo-local-de-teste';

function chamarMiddleware(authorization) {
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

test('token ausente retorna 401', () => {
  const resultado = chamarMiddleware(undefined);

  assert.equal(resultado.resposta.statusCode, 401);
  assert.deepEqual(resultado.resposta.body, { erro: 'Token não fornecido.' });
  assert.equal(resultado.proximo, false);
});

test('token inválido retorna 401', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const resultado = chamarMiddleware('Bearer token-invalido');

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
    const resultado = chamarMiddleware(`Bearer ${token}`);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, 401);
    assert.deepEqual(resultado.resposta.body, { erro: 'Token inválido ou expirado.' });
    assert.equal(resultado.proximo, false);
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});

test('token válido segue para a rota e popula req.usuario', async () => {
  const segredoAnterior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = segredoTeste;
  try {
    const token = jwt.sign({ id: 'usuario-teste' }, segredoTeste);
    const resultado = chamarMiddleware(`Bearer ${token}`);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultado.resposta.statusCode, null);
    assert.equal(resultado.proximo, true);
    assert.equal(resultado.req.usuario.id, 'usuario-teste');
  } finally {
    if (segredoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAnterior;
  }
});
