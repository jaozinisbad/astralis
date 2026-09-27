const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const eventosConta = require('../eventosConta');

const ERRO_CODIGO = 'Código inválido ou expirado. Peça outro código ao suporte.';

function hashCodigo(codigo) {
  return crypto.createHash('sha256').update(codigo).digest('hex');
}

function criarRouterRecuperacao({
  executar = (sql, parametros) => require('../db').query(sql, parametros),
  hashSenha = (senha) => bcrypt.hash(senha, 10),
  aoRedefinir = (usuarioId, versaoSessao) => eventosConta.emit('senha-redefinida', usuarioId, versaoSessao),
} = {}) {
  const router = express.Router();
  const acessosPorIp = new Map();

  router.post('/redefinir-senha', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.trim() : '';
    const novaSenha = req.body?.novaSenha;

    if (!email || email.length > 254 || !codigo || codigo.length > 200 ||
        typeof novaSenha !== 'string' || novaSenha.length < 8 || novaSenha.length > 128) {
      return res.status(400).json({ erro: 'Informe e-mail, código e uma nova senha de 8 a 128 caracteres.' });
    }

    const agora = Date.now();
    const chave = req.ip;
    const janela = acessosPorIp.get(chave);
    const atual = !janela || janela.expira <= agora ? { quantidade: 0, expira: agora + 15 * 60_000 } : janela;
    atual.quantidade += 1;
    acessosPorIp.set(chave, atual);
    if (acessosPorIp.size > 1000) {
      for (const [ip, registro] of acessosPorIp) {
        if (registro.expira <= agora) acessosPorIp.delete(ip);
      }
      while (acessosPorIp.size > 1000) acessosPorIp.delete(acessosPorIp.keys().next().value);
    }
    if (atual.quantidade > 30) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }

    try {
      // Consultas erradas não invalidam o código legítimo. A resposta não
      // revela se o e-mail existe; o limite por IP protege contra abuso.
      const tentativa = await executar(
        `SELECT r.codigo_hash FROM recuperacoes_senha r
         JOIN usuarios u ON u.id = r.usuario_id
         WHERE BTRIM(u.email) = BTRIM(?) AND r.expira_em > NOW()`,
        [email],
      );
      const informado = Buffer.from(hashCodigo(codigo), 'hex');
      const valido = tentativa.rows.reduce((encontrou, linha) => {
        const salvo = Buffer.from(linha.codigo_hash, 'hex');
        return (salvo.length === informado.length && crypto.timingSafeEqual(informado, salvo)) || encontrou;
      }, false);
      if (tentativa.rows.length === 0) crypto.timingSafeEqual(informado, Buffer.alloc(32));
      if (!valido) return res.status(400).json({ erro: ERRO_CODIGO });

      const senhaHash = await hashSenha(novaSenha);
      // DELETE + UPDATE na mesma instrução tornam o código de uso único.
      const atualizado = await executar(
        `WITH codigo_consumido AS (
           DELETE FROM recuperacoes_senha
           WHERE usuario_id IN (SELECT id FROM usuarios WHERE BTRIM(email) = BTRIM(?))
             AND codigo_hash = ? AND expira_em > NOW()
           RETURNING usuario_id
         )
         UPDATE usuarios SET senha_hash = ?, versao_sessao = versao_sessao + 1
         WHERE id = (SELECT usuario_id FROM codigo_consumido)
         RETURNING id, versao_sessao`,
        [email, hashCodigo(codigo), senhaHash],
      );
      const usuarioId = atualizado.rows[0]?.id;
      if (!usuarioId) return res.status(400).json({ erro: ERRO_CODIGO });

      aoRedefinir(usuarioId, atualizado.rows[0].versao_sessao);
      return res.json({ mensagem: 'Senha redefinida. Entre com a nova senha.' });
    } catch (erro) {
      return next(erro);
    }
  });

  return router;
}

module.exports = criarRouterRecuperacao();
module.exports.criarRouterRecuperacao = criarRouterRecuperacao;
