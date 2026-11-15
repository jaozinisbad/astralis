# Servidor Astralis em Rust

A API usa Axum, SQLx e Socketioxide com o PostgreSQL do Astralis.
Mantém o formato das contas e sessões, os eventos do cliente e os contratos
de servidores, canais, mensagens, amizades, voz, chamadas privadas e salas
de tela. O cliente continua usando WebRTC para áudio e vídeo.

## Compilar e executar

Compile com Rust 1.94 ou superior. O Render usa a versão fixada no
`render.yaml`.

```sh
cargo build --release --locked
./target/release/astralis-server
```

Defina `DATABASE_URL`, `JWT_SECRET` e `PORT` no ambiente do serviço. Use
as configurações PostgreSQL, JWT e TURN do backend existente para que
as sessões e o acesso ao banco continuem funcionando. `PG_POOL_MAX`
tem padrão 5. `/health` verifica o banco e responde com o cabeçalho
`X-Astralis-Backend: rust`.

O comando `astralis-server suporte-contas buscar <nome-ou-email>` consulta
contas. `astralis-server suporte-contas gerar <id>` pede confirmação antes
de gerar um código temporário de recuperação.

## Executar a comparação

Use um PostgreSQL de teste em `127.0.0.1` e crie um banco vazio chamado
`astralis_rust_test`. Instale as dependências de `server/` e `client/`
com `npm ci` nos respectivos diretórios. A comparação usa o cliente Socket.IO
do Astralis e inicializa o esquema pelo código do servidor Node.js.

No PowerShell, a partir de `server-rust/`:

```powershell
$env:ASTRALIS_TEST_DATABASE_URL = 'postgresql://usuario:senha@127.0.0.1:5432/astralis_rust_test'
cargo build --release --locked
node compare.cjs
```

O script usa a porta 3301 por padrão. Defina `ASTRALIS_RUST_PORT` para
escolher outra. Cada rodada usa contas descartáveis e uma chave de sessão
gerada na hora. Além do login e das mensagens, o roteiro usa o cliente
Socket.IO real para validar chamadas, sinalização de salas e permissões.

A carga mantém até 16 mensagens pendentes e espera 4.000 entregas por
implementação em cada uma das três rodadas, após 1.000 mensagens de
aquecimento. A latência é medida entre o envio
e a entrega ao destinatário. No Windows, o script também registra o tempo
de CPU do processo durante a carga e a memória residente ao final. O banco
e o cliente de teste ficam fora dessas duas medições.
