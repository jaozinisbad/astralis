# Contexto para retomada

Atualizado em 2026-09-25 a partir dos arquivos e histórico disponíveis localmente.

## Estado verificado no repositório

- O aplicativo é o **Astralis**, versão **1.3.4** no `client/package.json`.
- A proposta é um aplicativo comunitário para desktop (Windows e macOS), com cliente **React + Electron + Vite**.
- O backend usa **Node.js, Express e Socket.IO**; a persistência em execução usa **PostgreSQL**, com o driver `pg`.
- O repositório remoto `origin` é `https://github.com/jaozinisbad/astralis.git`.
- O histórico local já contém o commit `98db3f9` (migração do backend de SQLite para Neon PostgreSQL), além de commits de rebranding para Astralis, como `1d1fe64`.
- `README.md` e `docs/render.md` descrevem Render para hospedar o backend e Neon para PostgreSQL. O README também descreve atualizações do cliente por GitHub Releases.
- Os arquivos de dependências confirmam React, Electron, Express, Socket.IO e `pg` nos pacotes de cliente e servidor.

## Migração: documentação e validação

`docs/render.md` afirma que os dados foram importados e validados em `migration-test` e depois em `production`, e que a branch principal contém 11 contas e dados relacionados. Isso é o **registro da documentação do projeto**. A presença e integridade atuais desses dados no serviço remoto ainda precisam de validação nesta fase; não considerar a afirmação documental como verificação remota recém-realizada.

## Restrições e decisões registradas

- Manter o custo de operação em **zero**, dentro das opções gratuitas disponíveis.
- **Preservar os dados existentes**; não executar migração destrutiva nem apontar o serviço para um banco incerto.
- Manter o produto como aplicativo **desktop**. O Render serve o backend; o Electron é instalado nos computadores dos jogadores.
- Não registrar credenciais, tokens ou conteúdo de arquivos `.env` neste documento.
- `docs/render.md` recomenda manter o `JWT_SECRET` atual para preservar sessões e só publicar após confirmar que `DATABASE_URL` aponta para o banco de produção correto.

## Pendências desta retomada

- Validar no Render e no Neon, por meios remotos apropriados, o estado do serviço, o banco configurado e a preservação dos dados antes de qualquer mudança de publicação.
- Revisar o problema de resposta **403 durante logout** e identificar a causa no fluxo cliente/backend; corrigir somente após confirmar o comportamento esperado.
- Depois da validação, conferir login com conta existente, leitura e envio de mensagens, conexão Socket.IO e comunicação entre dois clientes, conforme `docs/render.md`.
- Considerar que o diretório de trabalho já tinha alterações locais não relacionadas nesta fase. Preservá-las ao continuar.

## Prompt breve para a próxima IA no VS Code

> Leia `docs/CONTEXTO-RETOMADA.md`, `README.md` e `docs/render.md` antes de agir. Continue validando Render/Neon e investigando o 403 no logout. Preserve os dados, mantenha custo zero e o cliente desktop. A documentação registra 11 contas migradas, mas a validação remota atual continua pendente. Não execute migração destrutiva nem exponha credenciais; preserve alterações locais existentes.
