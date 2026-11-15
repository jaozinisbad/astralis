# Migração do backend do Astralis para Rust

Migrar o backend existente para Axum, SQLx e Socketioxide, com o mesmo
PostgreSQL e contratos HTTP e Socket.IO do Astralis 1.7.1. Usar a versão
Node.js como referência nos testes. Publicar pelo atualizador integrado
após a validação funcional e a verificação do backend publicado.

- [x] Portar esquemas, permissões, mensagens HTTP e administração de servidores em `server-rust/src/guilds.rs`. Conferir papéis, cargos, banimentos, convites, canais e histórico com PostgreSQL descartável.
- [x] Portar contas, recuperação e amizades em `server-rust/src/accounts.rs`. Verificar compatibilidade com hashes, JWTs, amizade, histórico e invalidar sessões anteriores após redefinir a senha.
- [x] Portar salas de tela, sinalização WebRTC e reprodução compartilhada em `server-rust/src/stream_rooms.rs`. Comparar os eventos de entrada, saída, espectadores, disputa de papéis, reconexão e isolamento de salas.
- [x] Portar presença, texto, voz e chamadas privadas em `server-rust/src/realtime.rs` e `server-rust/src/direct_calls.rs`. Exercitar autorização, entrega para várias sessões, aceitação e encerramento.
- [x] Integrar a inicialização do mesmo esquema no Rust, com TLS PostgreSQL, CORS, estado de sessão, configurações ICE/TURN e comandos operacionais. Rodar o cliente existente contra o candidato com dados descartáveis.
- [ ] Validar a sinalização, o áudio e o vídeo com duas sessões do cliente, conferir a recuperação após desconexão e executar a comparação com Node.js. Preparar a transição de backend com caminho de reversão.
- [ ] Publicar e verificar os arquivos do atualizador do Windows, incluindo `latest.yml`, instalador e blockmap. Conferir o commit publicado, a saúde do backend e a detecção da versão pelo app anterior.
