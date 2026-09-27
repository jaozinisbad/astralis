const crypto = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline/promises');

function criarCodigo() {
  const codigo = crypto.randomBytes(24).toString('base64url');
  const codigoHash = crypto.createHash('sha256').update(codigo).digest('hex');
  return { codigo, codigoHash };
}

async function executar() {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const { db, query } = require('../db');
  const [comando, argumento] = process.argv.slice(2);

  try {
    if (comando === 'buscar') {
      const termo = String(argumento || '').trim();
      if (termo.length < 3 || termo.length > 80) throw new Error('Informe pelo menos 3 caracteres do nome ou e-mail.');
      const resultado = await query(
        'SELECT id, nome, email, criado_em FROM usuarios WHERE nome ILIKE ? OR email ILIKE ? ORDER BY criado_em DESC LIMIT 20',
        [`%${termo}%`, `%${termo}%`],
      );
      console.table(resultado.rows);
      return;
    }

    if (comando === 'gerar') {
      const usuarioId = Number(argumento);
      if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) throw new Error('Informe o ID numérico da conta.');
      const resultado = await query('SELECT id, nome, email FROM usuarios WHERE id = ?', [usuarioId]);
      const usuario = resultado.rows[0];
      if (!usuario) throw new Error('Conta não encontrada.');

      const entrada = readline.createInterface({ input: process.stdin, output: process.stdout });
      let resposta;
      try {
        resposta = await entrada.question(
          `Conta: ${usuario.nome} (${usuario.email}). Confirme a identidade por outro contato. Digite GERAR ${usuarioId} para criar o código: `,
        );
      } finally {
        entrada.close();
      }
      if (resposta.trim() !== `GERAR ${usuarioId}`) {
        console.log('Operação cancelada.');
        return;
      }

      const { codigo, codigoHash } = criarCodigo();
      await query(
        `INSERT INTO recuperacoes_senha (usuario_id, codigo_hash, expira_em)
         VALUES (?, ?, NOW() + INTERVAL '20 minutes')
         ON CONFLICT (usuario_id) DO UPDATE
         SET codigo_hash = EXCLUDED.codigo_hash, expira_em = EXCLUDED.expira_em`,
        [usuarioId, codigoHash],
      );
      console.log(`E-mail da conta: ${usuario.email}`);
      console.log(`Código de recuperação (uso único, 20 minutos): ${codigo}`);
      console.log('Envie o e-mail e o código somente à pessoa identificada, por um canal privado.');
      return;
    }

    console.log('Uso: npm run suporte:contas -- buscar <nome-ou-email>');
    console.log('     npm run suporte:contas -- gerar <id-da-conta>');
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  executar().catch((erro) => {
    console.error(erro.message);
    process.exitCode = 1;
  });
}

module.exports = { criarCodigo };
