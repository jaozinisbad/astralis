export function emitirSolicitacaoSala(socket, evento, dados, {
  connectionTimeoutMs = 60_000,
  responseTimeoutMs = 12_000,
  signal,
} = {}) {
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true });
  if (!socket || typeof socket.emit !== 'function') {
    return Promise.resolve({ ok: false, error: 'Não foi possível conectar ao servidor de salas.' });
  }

  return new Promise((resolve) => {
    let encerrado = false;
    let temporizadorConexao;
    let temporizadorResposta;

    const encerrar = (resultado) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(temporizadorConexao);
      clearTimeout(temporizadorResposta);
      socket.off?.('connect', enviar);
      socket.off?.('connect_error', erroConexao);
      socket.off?.('disconnect', desconectou);
      signal?.removeEventListener('abort', cancelar);
      resolve(resultado);
    };
    const cancelar = () => encerrar({ ok: false, cancelled: true });
    const erroConexao = () => {
      // Falhas de transporte mantêm a reconexão automática do Socket.IO ativa.
      // O prazo de conexão continua valendo enquanto o serviço desperta.
      if (socket.active === true) return;
      encerrar({
        ok: false,
        error: 'Não foi possível estabelecer a conexão com o servidor de salas.',
      });
    };
    const desconectou = () => encerrar({
      ok: false,
      error: 'A conexão com o servidor caiu. Tente novamente.',
    });
    const enviar = () => {
      clearTimeout(temporizadorConexao);
      socket.off?.('connect', enviar);
      temporizadorResposta = setTimeout(() => encerrar({
        ok: false,
        error: 'O servidor de salas não respondeu. A versão publicada pode estar desatualizada.',
      }), responseTimeoutMs);
      try {
        socket.emit(evento, dados, (resultado) => encerrar(resultado || {
          ok: false,
          error: 'O servidor enviou uma resposta inválida.',
        }));
      } catch {
        encerrar({ ok: false, error: 'Não foi possível enviar a solicitação de sala.' });
      }
    };

    socket.on?.('connect_error', erroConexao);
    socket.on?.('disconnect', desconectou);
    signal?.addEventListener('abort', cancelar, { once: true });
    if (socket.connected === false) {
      socket.on?.('connect', enviar);
      temporizadorConexao = setTimeout(() => encerrar({
        ok: false,
        error: 'A conexão com o servidor de salas demorou. Tente novamente.',
      }), connectionTimeoutMs);
      // Uma recusa do servidor desativa a reconexão automática. Um novo pedido
      // (como "Tentar novamente") precisa iniciar outra conexão explicitamente.
      if (socket.active === false) socket.connect?.();
    } else {
      enviar();
    }
  });
}
