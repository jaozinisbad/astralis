const jwt = require('jsonwebtoken');

function criarAutenticador(buscarVersao = async (id) => {
  const { get } = require('../db');
  return get('SELECT versao_sessao FROM usuarios WHERE id = ?', id);
}) {
  return function autenticar(req, res, next) {
    const cabecalho = req.headers.authorization;
    const token = cabecalho && cabecalho.split(' ')[1];

    if (!token) {
      return res.status(401).json({ erro: 'Token não fornecido.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, payload) => {
      if (err) {
        return res.status(401).json({ erro: 'Token inválido ou expirado.' });
      }
      try {
        const usuario = await buscarVersao(payload.id);
        if (!usuario || Number(usuario.versao_sessao) !== Number(payload.versao_sessao ?? 0)) {
          return res.status(401).json({ erro: 'Token inválido ou expirado.' });
        }
        req.usuario = payload;
        next();
      } catch (erro) {
        next(erro);
      }
    });
  };
}

module.exports = criarAutenticador();
module.exports.criarAutenticador = criarAutenticador;
