function createSocketAuthMiddleware({ verifyToken, getSessionVersion }) {
  return (socket, next) => {
    const auth = socket.handshake?.auth || {};
    const token = auth.token;
    if (!token && auth.modo === 'espectador') {
      socket.espectadorAnonimo = true;
      return next();
    }
    if (!token) return next(new Error('Token não fornecido.'));

    verifyToken(token, (erro, payload) => {
      if (erro || !payload) return next(new Error('Token inválido.'));
      Promise.resolve(getSessionVersion(payload.id)).then((versaoSessao) => {
        if (versaoSessao == null || Number(versaoSessao) !== Number(payload.versao_sessao ?? 0)) {
          return next(new Error('Token inválido.'));
        }
        socket.usuario = payload;
        return next();
      }).catch(next);
    });
  };
}

module.exports = { createSocketAuthMiddleware };
