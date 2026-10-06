# Banco e publicação no Render

O servidor usa PostgreSQL no Neon. O Render continua hospedando apenas o
backend Express + Socket.IO; o cliente Electron é instalado nos computadores
dos jogadores.

## Configuração local

Copie `server/.env.example` para `server/.env`, preencha `DATABASE_URL` com a
URL pooled da branch de teste do Neon e defina um `JWT_SECRET` longo e aleatório.
Não compartilhe nem envie o arquivo `.env` ao Git. O banco local SQLite é a
origem da migração; o backend não o usa mais em execução.

## Migração e validação

O script `server/scripts/migrate-sqlite-to-postgres.js` recria o schema público
do banco de destino antes de importar os dados locais. Use-o somente em uma
branch Neon descartável, nunca em produção, e defina
`ALLOW_DESTRUCTIVE_MIGRATION=1` conscientemente. Os dados foram importados e
validados primeiro em `migration-test` e depois na branch `production`. A
branch principal contém as 11 contas e os dados de servidores, mensagens,
cargos e amizades da base local.

A branch principal do Neon já contém os dados do app. A branch de teste expira
e não deve ser usada como banco permanente.

## Configuração do Render

O `render.yaml` define o serviço gratuito e pede `DATABASE_URL` como variável
secreta, sem incluir credenciais no repositório. No Dashboard do Render,
configure essa variável com a URL pooled do branch de produção do Neon. Mantenha
`JWT_SECRET` igual ao valor atual do serviço para preservar as sessões existentes.
Não aplique um novo deploy até confirmar que a branch de produção já contém os
dados necessários e que `DATABASE_URL` aponta para ela.

O endpoint `/` serve como health check. Após configurar banco e publicar,
valide login com a conta existente, leitura de mensagens, envio de mensagem,
conexão Socket.IO e acesso a partir de dois clientes.

### Evitar reinícios por alterações fora do backend

Em **Settings → Build → Build Filters**, mantenha estes **Included Paths**,
relativos à raiz do repositório:

```text
server/**
render.yaml
```

O mesmo filtro já está declarado em `render.yaml`. Em um serviço criado pelo
Dashboard sem sincronização por Blueprint, alterar o YAML não atualiza as
configurações do serviço: confira e salve o filtro também no painel.

Assim, mudanças no README, nas demais documentações e no cliente não acionam
um deploy automático do backend. Mudanças no servidor continuam acionando.
As salas ficam na memória do processo e são perdidas quando a instância é
substituída; planeje os deploys do backend para fora das transmissões em uso.

Em 05/10/2026, o filtro foi aplicado ao serviço existente depois de confirmar
nos logs que pushes de documentação haviam reiniciado a instância e
desconectado os participantes. Essa configuração evita esses deploys
desnecessários, mas não impede reinícios da plataforma ou falhas de rede.

## Cliente Electron

Configure `VITE_SERVER_URL` em `client/.env.local` com a URL do backend Render.
Essa variável entra no build; gere e distribua uma nova versão do cliente após
alterá-la. Instalações antigas continuam usando a URL compilada anteriormente.

Voz e compartilhamento de tela usam WebRTC ponto a ponto. O Render hospeda a
sinalização, mas não substitui um servidor TURN nas redes que exigem relay.
