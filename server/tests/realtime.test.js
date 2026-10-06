const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Executa os handlers reais com banco e transporte isolados, sem tocar produção.
function criarServidor({ autorizado = true, bancoDisponivel = true } = {}) {
  const handlers = {};
  const endpoints = {};
  const enviados = [];
  const registros = [];
  const erros = [];
  let conectar;
  const socket = {
    id: 'socket-teste', usuario: { id: 7, nome: 'Teste' },
    on: (evento, callback) => { handlers[evento] = callback; },
  };
  const io = {
    use() {},
    on: (_evento, callback) => { conectar = callback; },
    to: (destino) => ({ emit: (evento, dados) => enviados.push({ destino, evento, dados }) }),
  };
  const app = {
    use() {},
    get: (rota, handler) => { endpoints[rota] = handler; },
  };
  const express = Object.assign(() => app, { json: () => () => {} });
  const db = {
    initDb: async () => {},
    all: async () => [],
    get: async (sql, ...args) => {
      if (!bancoDisponivel) throw new Error('Banco indisponível');
      if (sql.startsWith('INSERT INTO')) {
        const id = 123 + registros.length;
        registros.push({ id, args });
        return { id };
      }
      return { servidor_id: 2 };
    },
  };
  const modules = {
    dotenv: { config() {} }, express,
    http: { createServer: () => ({ listen() {} }) },
    cors: () => () => {}, jsonwebtoken: {},
    'socket.io': { Server: function () { return io; } },
    './db': db,
    './routes/auth': {}, './routes/mensagens': {},
    './routes/servidores': {
      router: {}, ehMembro: async () => autorizado, temPermissao: async () => autorizado,
    },
    './routes/amigos': { router: {}, compartilhamServidor: async () => autorizado },
    './presenca': { socketsPorUsuario: new Map([[7, new Set(['socket-teste'])], [8, new Set(['amigo'])]]) },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../index.js'), 'utf8'), {
    require: (name) => {
      assert.ok(name in modules, `Dependência não isolada: ${name}`);
      return modules[name];
    },
    process: { env: {} }, console: { log() {}, error: (...args) => erros.push(args) },
  });
  conectar(socket);
  return { handlers, enviados, registros, endpoints, erros };
}

async function enviar(servidor, evento, dados) {
  servidor.handlers[evento](dados);
  await new Promise(setImmediate);
}

test('chat transmite o identificador persistido pelo PostgreSQL', async () => {
  const servidor = criarServidor();
  await enviar(servidor, 'enviar-mensagem', { canalId: 3, conteudo: ' Olá ' });
  assert.equal(servidor.registros.length, 1);
  assert.equal(servidor.enviados[0].evento, 'nova-mensagem');
  assert.equal(servidor.enviados[0].dados.mensagem.id, servidor.registros[0].id);
  assert.equal(servidor.enviados[0].dados.mensagem.conteudo, 'Olá');
});

test('DM entrega o mesmo identificador persistido para remetente e destinatário', async () => {
  const servidor = criarServidor();
  await enviar(servidor, 'enviar-dm', { paraUsuarioId: 8, conteudo: 'Olá' });
  assert.equal(servidor.enviados.length, 2);
  assert.deepEqual(servidor.enviados.map((item) => item.destino).sort(), ['amigo', 'socket-teste']);
  for (const item of servidor.enviados) assert.equal(item.dados.mensagem.id, servidor.registros[0].id);
});

test('não persiste nem transmite chat ou DM sem acesso ao servidor', async () => {
  const servidor = criarServidor({ autorizado: false });
  await enviar(servidor, 'enviar-mensagem', { canalId: 3, conteudo: 'Olá' });
  await enviar(servidor, 'enviar-dm', { paraUsuarioId: 8, conteudo: 'Olá' });
  assert.equal(servidor.registros.length, 0);
  assert.equal(servidor.enviados.length, 0);
});

test('health indica indisponibilidade quando o banco não responde', async () => {
  for (const bancoDisponivel of [true, false]) {
    const servidor = criarServidor({ bancoDisponivel });
    let status = 200;
    let resultado;
    const res = {
      set() {}, status(code) { status = code; return this; },
      json(value) { resultado = value; },
    };
    await servidor.endpoints['/health']({}, res);
    assert.equal(status, bancoDisponivel ? 200 : 503);
    assert.equal(resultado.status, bancoDisponivel ? 'ok' : 'unavailable');
  }
});
