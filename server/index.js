require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { all, get, run, initDb } = require('./db');
const authRoutes = require('./routes/auth');
const { router: servidoresRoutes, ehMembro, temPermissao } = require('./routes/servidores');
const mensagensRoutes = require('./routes/mensagens');
const { router: amigosRoutes, compartilhamServidor } = require('./routes/amigos');
const { socketsPorUsuario } = require('./presenca');
const recuperacaoRoutes = require('./routes/recuperacao');
const eventosConta = require('./eventosConta');
const { createSocketAuthMiddleware } = require('./socketAuth');
const { createStreamRoomManager, registerStreamRoomEvents } = require('./streamRooms');

const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const server = http.createServer(app);

// CORS liberado por enquanto (grupo fechado de amigos, sem exposição pública ampla).
// Quando o Cloudflare Tunnel estiver configurado, dá pra restringir à sua origem.
app.use(cors());

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 8e6,
});
const streamRoomManager = createStreamRoomManager();

app.use(express.json({ limit: '8mb' }));

app.get('/', (req, res) => {
  res.send('Servidor do app de comunicação está no ar!');
});

// Verifica também o banco, que pode estar retomando após inatividade.
app.get('/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await get('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api', authRoutes);
app.use('/api', recuperacaoRoutes);
app.use('/api', servidoresRoutes);
app.use('/api', mensagensRoutes);
app.use('/api', amigosRoutes);

function servidorDoCanal(canalId) {
  return get('SELECT servidor_id FROM canais WHERE id = ?', canalId);
}

// Controle em memória de quem está em qual canal de voz (não precisa
// persistir no banco — é só presença em tempo real).
const canalVozParticipantes = {}; // canalId -> Map(socketId -> nome)
const asyncSocket = (handler) => (...args) => {
  Promise.resolve(handler(...args)).catch((error) => console.error('Erro em evento Socket.IO:', error));
};

async function amigosDe(usuarioId) {
  return all(
      `SELECT DISTINCT u.id
       FROM usuarios u
       JOIN membros_servidor m2 ON m2.usuario_id = u.id
       WHERE m2.servidor_id IN (
         SELECT servidor_id FROM membros_servidor WHERE usuario_id = ?
       )
       AND u.id != ?`
    , usuarioId, usuarioId).then((rows) => rows.map((linha) => linha.id));
}

async function avisarAmigos(usuarioId, evento) {
  (await amigosDe(usuarioId)).forEach((amigoId) => {
    const sockets = socketsPorUsuario.get(amigoId);
    sockets?.forEach((socketId) => io.to(socketId).emit(evento, { usuarioId }));
  });
}

async function membrosDoServidor(servidorId) {
  return (await all('SELECT usuario_id FROM membros_servidor WHERE servidor_id = ?', servidorId))
    .map((linha) => linha.usuario_id);
}

function listaParticipantesDoCanal(canalId) {
  const mapa = canalVozParticipantes[canalId];
  if (!mapa) return [];
  return Array.from(mapa.entries()).map(([socketId, dadosUsuario]) => ({
    socketId,
    usuarioId: dadosUsuario.usuarioId,
    nome: dadosUsuario.nome,
    avatarCor: dadosUsuario.avatarCor,
    avatarUrl: dadosUsuario.avatarUrl,
  }));
}

// Avisa TODO MUNDO do servidor (não só quem já está na call) quem está
// em cada canal de voz agora — é o que alimenta a pré-visualização de
// participantes na lista de canais, mesmo pra quem ainda não entrou.
async function avisarPresencaVoz(canalId) {
  const canal = await servidorDoCanal(canalId);
  if (!canal) return;

  const participantes = listaParticipantesDoCanal(canalId);
  (await membrosDoServidor(canal.servidor_id)).forEach((usuarioId) => {
    socketsPorUsuario.get(usuarioId)?.forEach((socketId) => {
      io.to(socketId).emit('presenca-voz-canal', { canalId, participantes });
    });
  });
}

function sairDoCanalVoz(socket) {
  const canalId = socket.canalVozAtual;
  if (!canalId) return;

  socket.leave(`voz-${canalId}`);
  canalVozParticipantes[canalId]?.delete(socket.id);
  io.to(`voz-${canalId}`).emit('peer-saiu', { socketId: socket.id });
  socket.canalVozAtual = null;
  void avisarPresencaVoz(canalId);
}

// Visitantes sem conta só recebem eventos de salas; qualquer outra conexão
// em tempo real continua exigindo uma sessão válida.
io.use(createSocketAuthMiddleware({
  verifyToken: (token, callback) => jwt.verify(token, process.env.JWT_SECRET, callback),
  getSessionVersion: async (usuarioId) => {
    const usuario = await get('SELECT versao_sessao FROM usuarios WHERE id = ?', usuarioId);
    return usuario ? Number(usuario.versao_sessao) : null;
  },
}));

const versoesRedefinidas = new Map();
eventosConta.on('senha-redefinida', (usuarioId, versaoSessao) => {
  versoesRedefinidas.set(usuarioId, Number(versaoSessao));
  socketsPorUsuario.get(usuarioId)?.forEach((socketId) => {
    io.sockets.sockets.get(socketId)?.disconnect(true);
  });
});

io.on('connection', (socket) => {
  if (socket.espectadorAnonimo) {
    registerStreamRoomEvents({ socket, io, manager: streamRoomManager });
    return;
  }

  console.log('Novo cliente conectado:', socket.usuario.nome);

  // Presença online: registra este socket para o usuário e avisa os
  // amigos (quem compartilha servidor) que ele ficou online — só na
  // primeira conexão desse usuário (se ele já tinha outra aba aberta,
  // já estava online, não precisa avisar de novo).
  // Fecha a janela entre a checagem do token e a entrada neste callback.
  const versaoMaisRecente = versoesRedefinidas.get(socket.usuario.id);
  if (versaoMaisRecente !== undefined && Number(socket.usuario.versao_sessao ?? 0) < versaoMaisRecente) {
    socket.disconnect(true);
    return;
  }
  registerStreamRoomEvents({ socket, io, manager: streamRoomManager });

  const jaEstavaOnline = socketsPorUsuario.has(socket.usuario.id);
  if (!socketsPorUsuario.has(socket.usuario.id)) socketsPorUsuario.set(socket.usuario.id, new Set());
  socketsPorUsuario.get(socket.usuario.id).add(socket.id);
  if (!jaEstavaOnline) void avisarAmigos(socket.usuario.id, 'amigo-online');

  // Entrar na "sala" de um canal de texto para receber as mensagens dele.
  socket.on('entrar-canal', asyncSocket(async (canalId) => {
    const canal = await servidorDoCanal(canalId);
    if (!canal || !(await ehMembro(canal.servidor_id, socket.usuario.id))) return;
    socket.join(`canal-${canalId}`);
  }));

  socket.on('sair-canal', (canalId) => {
    socket.leave(`canal-${canalId}`);
  });

  // Enviar mensagem: salva no banco e retransmite pra todo mundo na sala do canal.
  socket.on('enviar-mensagem', asyncSocket(async ({ canalId, conteudo, anexo }) => {
    const texto = typeof conteudo === 'string' ? conteudo.trim() : '';
    if (!texto && !anexo?.url) return;

    const canal = await servidorDoCanal(canalId);
    if (!canal || !(await ehMembro(canal.servidor_id, socket.usuario.id))) return;

    if (anexo?.url && (!String(anexo.url).startsWith('data:') || String(anexo.url).length > 7000000)) return;

    const resultado = await get('INSERT INTO mensagens (canal_id, usuario_id, conteudo, anexo_nome, anexo_tipo, anexo_url, anexo_tamanho) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      canalId, socket.usuario.id, texto, anexo?.nome || null, anexo?.tipo || null, anexo?.url || null, Number(anexo?.tamanho) || null);

    const mensagem = {
      id: resultado.id,
      conteudo: texto,
      autor: socket.usuario.nome,
      usuario_id: socket.usuario.id,
      anexo_nome: anexo?.nome || null,
      anexo_tipo: anexo?.tipo || null,
      anexo_url: anexo?.url || null,
      anexo_tamanho: Number(anexo?.tamanho) || null,
      criado_em: new Date().toISOString(),
    };

    io.to(`canal-${canalId}`).emit('nova-mensagem', { canalId, mensagem });
  }));

  // Apaga uma mensagem: o próprio autor sempre pode, ou quem tiver a
  // permissão de gerenciar mensagens de outras pessoas nesse servidor.
  socket.on('apagar-mensagem', asyncSocket(async ({ canalId, mensagemId }) => {
    const canal = await servidorDoCanal(canalId);
    if (!canal || !(await ehMembro(canal.servidor_id, socket.usuario.id))) return;

    const mensagem = await get('SELECT usuario_id FROM mensagens WHERE id = ? AND canal_id = ?', mensagemId, canalId);
    if (!mensagem) return;

    const ehAutor = mensagem.usuario_id === socket.usuario.id;
    if (!ehAutor && !(await temPermissao(canal.servidor_id, socket.usuario.id, 'gerenciar_mensagens'))) return;

    await run('DELETE FROM mensagens WHERE id = ?', mensagemId);
    io.to(`canal-${canalId}`).emit('mensagem-apagada', { canalId, mensagemId });
  }));

  // --- Canal de voz: presença + sinalização WebRTC ---

  socket.on('entrar-canal-voz', asyncSocket(async (canalId) => {
    const canal = await servidorDoCanal(canalId);
    if (!canal || !(await ehMembro(canal.servidor_id, socket.usuario.id))) return;

    // Se já estava em outro canal de voz, sai dele primeiro.
    sairDoCanalVoz(socket);

    if (!canalVozParticipantes[canalId]) canalVozParticipantes[canalId] = new Map();

    // Busca dados completos do usuário (incluindo avatar_cor e avatar_url)
    const usuario = await get('SELECT id, nome, avatar_cor, avatar_url FROM usuarios WHERE id = ?', socket.usuario.id);

    // Manda pro recém-chegado a lista de quem já está na chamada.
    const peers = Array.from(canalVozParticipantes[canalId].entries()).map(([socketId, dadosUsuario]) => ({
      socketId,
      usuarioId: dadosUsuario.usuarioId,
      nome: dadosUsuario.nome,
      avatarCor: dadosUsuario.avatarCor,
      avatarUrl: dadosUsuario.avatarUrl,
    }));
    socket.emit('peers-existentes', { peers });

    canalVozParticipantes[canalId].set(socket.id, {
      usuarioId: usuario.id,
      nome: usuario.nome,
      avatarCor: usuario.avatar_cor || '#5865f2',
      avatarUrl: usuario.avatar_url || null,
    });
    socket.join(`voz-${canalId}`);
    socket.canalVozAtual = canalId;

    socket.to(`voz-${canalId}`).emit('novo-peer', {
      socketId: socket.id,
      usuarioId: usuario.id,
      nome: usuario.nome,
      avatarCor: usuario.avatar_cor || '#5865f2',
      avatarUrl: usuario.avatar_url || null,
    });
    void avisarPresencaVoz(canalId);
  }));

  // Um cliente pede o retrato atual de quem está em cada canal de voz de
  // um servidor — usado quando abre a lista de canais, mesmo sem ter
  // entrado em nenhuma call ainda (pré-visualização).
  socket.on('obter-presenca-servidor', asyncSocket(async (servidorId) => {
    if (!(await ehMembro(servidorId, socket.usuario.id))) return;

    const canaisDeVoz = await all("SELECT id FROM canais WHERE servidor_id = ? AND tipo = 'voz'", servidorId);

    const participantesPorCanal = {};
    canaisDeVoz.forEach(({ id }) => {
      participantesPorCanal[id] = listaParticipantesDoCanal(id);
    });

    socket.emit('presenca-voz-servidor', { participantesPorCanal });
  }));

  socket.on('sair-canal-voz', () => sairDoCanalVoz(socket));

  // Expulsa alguém de um canal de voz — exige permissão nesse servidor.
  socket.on('expulsar-da-call', asyncSocket(async ({ canalId, usuarioId }) => {
    const canal = await servidorDoCanal(canalId);
    if (!canal) return;
    if (!(await temPermissao(canal.servidor_id, socket.usuario.id, 'expulsar_call'))) return;

    const socketsDoAlvo = socketsPorUsuario.get(usuarioId);
    socketsDoAlvo?.forEach((socketId) => {
      const socketAlvo = io.sockets.sockets.get(socketId);
      if (socketAlvo?.canalVozAtual === canalId) {
        socketAlvo.emit('voce-foi-expulso-da-call');
        sairDoCanalVoz(socketAlvo);
      }
    });
  }));

  socket.on('tela-parada', () => {
    if (socket.canalVozAtual) {
      socket.to(`voz-${socket.canalVozAtual}`).emit('tela-parada', { socketId: socket.id });
    }
  });

  // --- Mensagens diretas (fora de servidores) ---

  socket.on('enviar-dm', asyncSocket(async ({ paraUsuarioId, conteudo }) => {
    if (!conteudo || !conteudo.trim()) return;
    if (!(await compartilhamServidor(socket.usuario.id, paraUsuarioId))) return;

    const resultado = await get('INSERT INTO mensagens_diretas (remetente_id, destinatario_id, conteudo) VALUES (?, ?, ?) RETURNING id',
      socket.usuario.id, paraUsuarioId, conteudo.trim());

    const mensagem = {
      id: resultado.id,
      conteudo: conteudo.trim(),
      remetente_id: socket.usuario.id,
      criado_em: new Date().toISOString(),
    };

    // Entrega pra todas as sessões abertas do destinatário e ecoa de
    // volta pra todas as suas próprias sessões (pra sincronizar se
    // você tiver o app aberto em mais de um lugar).
    [paraUsuarioId, socket.usuario.id].forEach((usuarioId) => {
      socketsPorUsuario.get(usuarioId)?.forEach((socketId) => {
        io.to(socketId).emit('nova-dm', { comUsuarioId: paraUsuarioId, deUsuarioId: socket.usuario.id, mensagem });
      });
    });
  }));

  // Sinalização do fluxo legado de voz: só retransmite se os sockets ainda
  // estiverem juntos no mesmo canal. Salas de tela usam sala:sinal:* com
  // papéis verificados pelo gerenciador.
  function alvoNaMesmaCall(socketId) {
    if (typeof socketId !== 'string' || !socket.canalVozAtual) return false;
    const alvo = io.sockets.sockets.get(socketId);
    return Boolean(alvo && alvo.canalVozAtual === socket.canalVozAtual);
  }

  socket.on('webrtc-oferta', ({ para, oferta }) => {
    if (!alvoNaMesmaCall(para)) return;
    io.to(para).emit('webrtc-oferta', { de: socket.id, oferta });
  });
  socket.on('webrtc-resposta', ({ para, resposta }) => {
    if (!alvoNaMesmaCall(para)) return;
    io.to(para).emit('webrtc-resposta', { de: socket.id, resposta });
  });
  socket.on('webrtc-candidato', ({ para, candidato }) => {
    if (!alvoNaMesmaCall(para)) return;
    io.to(para).emit('webrtc-candidato', { de: socket.id, candidato });
  });

  socket.on('disconnect', () => {
    sairDoCanalVoz(socket);

    const sockets = socketsPorUsuario.get(socket.usuario.id);
    sockets?.delete(socket.id);
    if (sockets && sockets.size === 0) {
      socketsPorUsuario.delete(socket.usuario.id);
    void avisarAmigos(socket.usuario.id, 'amigo-offline');
    }

    console.log('Cliente desconectado:', socket.usuario.nome);
  });
});

// JSON inválido deve virar erro 400, nunca encerrar o processo do servidor.
app.use((erro, _req, res, next) => {
  if (erro instanceof SyntaxError && erro.status === 400 && erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido.' });
  }
  return next(erro);
});

const PORT = process.env.PORT || 3001;
initDb()
  .then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  }))
  .catch((error) => {
    console.error('Nao foi possivel iniciar o Postgres:', error);
    process.exitCode = 1;
  });
