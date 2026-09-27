# Contexto para retomar o Astralis no VS Code

Atualizado em 27/09/2026. Abra a pasta `astralis` que está dentro de `C:\Users\User\Documents\ChatGPT\app para gamers`. A pasta externa contém apenas um repositório Git vazio; o código e o histórico de desenvolvimento estão na pasta `astralis`. O projeto original em `C:\Users\User\Documents\projeto-app-gamers` foi preservado. Nesta retomada foram copiados o histórico, todas as alterações pendentes e as configurações locais ignoradas pelo Git. Não exponha o conteúdo dos arquivos `.env`.

## Decisões do usuário

- Manter hospedagem **sem custo**, preservar todas as contas e mensagens e distribuir o produto como aplicativo desktop.
- Trabalhar com autonomia e usar agentes mais leves para tarefas mecânicas.
- Ao fim de cada fase, atualizar este arquivo para retomada no VS Code.
- O problema atual é a demora ao abrir o aplicativo. O usuário confirmou o workspace Render `jaozinisbad projects` e autorizou continuar a publicação desta fase.

## Estado verificado

- Astralis versão **1.3.5** publicada: Electron, React e Vite no cliente; Express, Socket.IO e PostgreSQL (`pg`) no servidor. O Git remoto é `https://github.com/jaozinisbad/astralis.git`.
- O backend migrou de SQLite para Neon antes desta retomada. Consulta somente leitura na branch de produção em 25/09/2026 confirmou **11 usuários, 2 servidores, 4 canais, 8 mensagens de canal e 4 mensagens diretas**. A base SQLite original foi mantida. Não execute novamente `migrate-sqlite-to-postgres.js` na produção: o script derruba e recria o schema público.
- O cliente aponta para `https://app-gamers-server.onrender.com`. Duas requisições consecutivas ao endpoint público, em 25/09/2026, mediram **22,8 s** e **0,29 s**, respectivamente. Isso é compatível com a suspensão do plano gratuito após 15 minutos sem tráfego. O Render informa que a retomada pode levar cerca de um minuto: https://render.com/docs/free . As medições isoladas não garantem o mesmo tempo em todas as redes.
- O login/cadastro existente usa bcrypt e JWT próprios. O arquivo `neon.ts` declara Neon Auth, mas o aplicativo **ainda não usa Neon Auth**; não altere a identidade dos usuários por engano.
- O workspace Render `jaozinisbad projects` foi confirmado. Serviço `app-gamers-server` (`srv-dapaglrm8hqs7392mn60`), plano gratuito, branch `master`, deploy automático. O deploy `dep-dasbmh3ncjis73ec6040` do commit `ac96f5c` ficou `live` em 27/09/2026. `GET https://app-gamers-server.onrender.com/health` respondeu 200 com `{"status":"ok"}` em 2,1 s logo após o deploy. A consulta de logs retornou erro temporário da infraestrutura do Render; não imprimir segredos.

## Alterações locais desta fase

- `client/src/components/LoginScreen.jsx`: chama `/health` uma vez ao abrir a tela, iniciando o despertar do backend enquanto o usuário digita; mostra aviso após 4 segundos de espera; login tem limite de 90 segundos e mensagem específica quando o tempo se esgota. Não há chamadas periódicas para manter o serviço artificialmente ativo.
- `server/index.js`: adiciona `/health` que verifica conexão com PostgreSQL e responde 200 ou 503. Corrige os identificadores enviados em mensagens e DMs: agora usa o `id` retornado pelo `INSERT ... RETURNING id` do PostgreSQL.
- `client/src/App.jsx`: mostra carregamento da lista de servidores e canais, erro com botão para tentar novamente, e descarta respostas antigas ao trocar de servidor ou sessão. A tela não informa falsamente que a pessoa não possui servidores enquanto espera a API.
- `client/src/api.js` e `server/middleware/autenticar.js`: sessão inválida recebe 401; 403 de falta de permissão preserva o login. O cliente ainda reconhece a resposta antiga específica de token inválido em 403 para compatibilidade durante atualização gradual.
- Dependência de teste `react-test-renderer` 18.3.1 adicionada em `client/package.json`. Dependências foram restauradas com `npm ci`; o instalador do Electron foi concluído na nova pasta.
- Testes comportamentais adicionados para carregamento, retry, troca de servidor, login, estado da sessão, ids de mensagens e health.

## Validação local realizada

Na pasta `astralis/client`, `npm.cmd test` passou **18/18** e `npm.cmd run build` da versão 1.3.5 passou. Na pasta `astralis/server`, `npm.cmd test` passou **8/8**. `git diff --check` não apontou erros de espaço. O build do cliente emitiu um aviso de tamanho do bundle RNNoise, já volumoso; não impediu o build. O build precisou rodar fora do sandbox porque o esbuild recebeu `Access is denied` ao resolver `vite.config.js` dentro dele. `npm.cmd run release` terminou com sucesso. A release pública [v1.3.5](https://github.com/jaozinisbad/astralis/releases/tag/v1.3.5) está marcada como versão mais recente; a API pública do GitHub confirmou instalador Windows, blockmap e `latest.yml`, sem modo rascunho ou pré-lançamento. Não houve teste ponta a ponta com duas instalações nesta fase.

## Próximos passos

1. Instalar ou atualizar o aplicativo para 1.3.5 e fazer teste manual com login existente, canais, mensagens, DMs, Socket.IO, voz e compartilhamento em dois computadores. Repetir medida do primeiro acesso após inatividade. O plano gratuito do Render ainda poderá suspender e despertar; eliminar o atraso estrutural requer um plano que permaneça ativo ou outra infraestrutura com disponibilidade contínua, sujeito ao limite de custo escolhido pelo usuário.
2. Manter as alterações locais preexistentes (`neon.ts`, `package.json` da raiz, `package-lock.json`, `.agents/`, `skills-lock.json`) intactas. Não publicar arquivos de ambiente, banco SQLite ou credenciais. Não executar `migrate-sqlite-to-postgres.js` em produção.

## Prompt para colar na IA do VS Code

> Continue o Astralis na pasta `C:\Users\User\Documents\ChatGPT\app para gamers\astralis`. Leia `docs/CONTEXTO-RETOMADA.md`, `docs/render.md` e `README.md`. Preserve dados e segredos; mantenha custo zero e app desktop. A produção Neon foi verificada com 11 usuários, 2 servidores e mensagens. O primeiro acesso ao Render gratuito levou 22,8 s; o segundo, 0,29 s. As correções para carregamento, retry, sessão, health e ids de mensagens passaram 18 testes cliente, 8 backend e build. A versão Electron 1.3.5 foi publicada em GitHub Releases; backend do commit `ac96f5c` ficou live no Render e `/health` respondeu 200. Teste manualmente a atualização, login e recursos em dois computadores; meça novamente após inatividade. Preserve as alterações locais preexistentes da raiz e não rode migração destrutiva. Atualize este arquivo ao fim da próxima fase.
