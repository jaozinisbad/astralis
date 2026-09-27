const jwt = require('jsonwebtoken');

function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization;
  const token = cabecalho && cabecalho.split(' ')[1];

  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }
    req.usuario = payload;
    next();
  });
}

module.exports = autenticar;
