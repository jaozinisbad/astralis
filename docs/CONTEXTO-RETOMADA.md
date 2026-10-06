# Contexto para retomar o Astralis no VS Code

Atualizado em 27/09/2026. Abra a pasta `astralis` que está dentro de `C:\Users\User\Documents\ChatGPT\app para gamers`. A pasta externa contém apenas um repositório Git vazio; o código e o histórico de desenvolvimento estão na pasta `astralis`. O projeto original em `C:\Users\User\Documents\projeto-app-gamers` foi preservado. Nesta retomada foram copiados o histórico, todas as alterações pendentes e as configurações locais ignoradas pelo Git. Não exponha o conteúdo dos arquivos `.env`.

## Decisões do usuário

- Manter hospedagem **sem custo**, preservar todas as contas e mensagens e distribuir o produto como aplicativo desktop.
- Trabalhar com autonomia e usar agentes mais leves para tarefas mecânicas.
- Ao fim de cada fase, atualizar este arquivo para retomada no VS Code.
- Manter o servidor no Render. O usuário autorizou publicar a correção do convite como release do aplicativo desktop. O convite precisa poder ser copiado e enviado aos amigos, com alternativa manual se a área de transferência falhar.

## Estado verificado

- Astralis versão **1.3.11** publicada: Electron, React e Vite no cliente; Express, Socket.IO e PostgreSQL (`pg`) no servidor. O Git remoto é `https://github.com/jaozinisbad/astralis.git`.
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

## Instalação local para teste

Em 27/09/2026, a instalação anterior para todos os usuários em `C:\Program Files\Astralis` estava na versão 1.3.4 e o aplicativo não estava aberto. O instalador local `client/release/Astralis Setup 1.3.5.exe` foi executado em modo silencioso para todos os usuários; o Windows solicitou elevação e o usuário a permitiu. O registro de desinstalação e o `package.json` embutido no `app.asar` confirmaram a versão 1.3.5 na mesma pasta. As pastas de dados do usuário em AppData permaneceram presentes. O aplicativo foi aberto e seus processos estavam em execução. O usuário ainda fará o teste funcional da interface, login e recursos.

## Próximos passos

1. O usuário quer ajudar amigos que esqueceram e-mail e senha. O guia `docs/SUPORTE-CONTAS.md` ensina a localizar contas no Neon `production` e a gerar código de recuperação privado pelo script local. **Nenhuma conta específica foi redefinida ainda**: é preciso identificar a pessoa e confirmar sua identidade por outro contato antes de gerar o código. A pessoa atualiza para 1.3.11, clica em “Esqueceu a senha?” e escolhe uma nova senha.
2. Instalar a versão 1.3.11 no computador do usuário e dos amigos após encerrarem o uso do app; a versão 1.3.10 ainda está instalada localmente e em execução. Testar a recuperação com uma conta de teste e o áudio da transmissão com duas pessoas. Testar também o fluxo real do convite.
3. Manter as alterações locais preexistentes (`neon.ts`, `package.json` da raiz, `package-lock.json`, `.agents/`, `skills-lock.json`) intactas. Não publicar arquivos de ambiente, banco SQLite ou credenciais. Não executar `migrate-sqlite-to-postgres.js` em produção.

## Alteração local de interface em 27/09/2026

- A transmissão agora fica oculta por padrão. Participantes que compartilham tela recebem um botão “AO VIVO” junto ao nome na lista da chamada; clicar abre uma transmissão no palco central, e “Fechar” retorna à interface limpa sem sair da chamada.
- A revisão leve com subagente apontou e corrigimos o fechamento automático da visualização ao navegar entre canais, servidores, Amigos e DMs, e ao sair da conta ou remover o canal de voz ativo.
- A implementação inicial da interface alterou `client/src/App.jsx`, `client/src/components/ChannelSidebar.jsx`, `client/src/components/VoiceChannel.jsx` e `client/src/styles.css`. O build de produção passou e a versão 1.3.6 foi empacotada e instalada localmente para o teste inicial. Não houve publicação nem teste funcional com duas pessoas nessa etapa.

## Ajuste de tela cheia em 27/09/2026

- O botão de tela cheia também aparece ao visualizar a própria transmissão. O player usa o painel inteiro no modo tela cheia, mantém os controles disponíveis e o botão alterna para “Sair da tela cheia”; `Escape` também retorna ao app.
- `npm.cmd run dist` gerou `client/release/Astralis Setup 1.3.7.exe` localmente. Instalador concluído; o `package.json` dentro de `C:\Program Files\Astralis\resources\app.asar` confirma 1.3.7 e os processos do app estão abertos. Falta validar a tela cheia no uso real. Nenhuma versão foi publicada no GitHub ou no Render.

## Controle de volume da transmissão em 27/09/2026

- O player agora tem slider individual de 0% a 100% e botão “Silenciar/Ativar som” para o áudio da transmissão remota. O nível fica guardado por participante durante a chamada e multiplica o volume mestre da saída; não altera vozes nem microfone. O vídeo fica sem áudio próprio para evitar duplicação, porque a transmissão usa um elemento de áudio separado.
- Revisão leve com subagente confirmou o fluxo de áudio separado e identificou/corrigiu um callback obsoleto ao participante sair da chamada.
- `npm.cmd run dist` passou e criou `client/release/Astralis Setup 1.3.8.exe`. A instalação terminou: `C:\Program Files\Astralis\resources\app.asar` confirma 1.3.8 e os processos do Astralis estão abertos. Falta testar o slider em uma chamada com áudio de tela. Nenhuma publicação remota foi feita.

## Convite e release 1.3.9 em 27/09/2026

- “Convidar para o servidor” abre uma janela com o código selecionável, instrução de entrada, botão para copiar só o código e botão para copiar uma mensagem pronta. “Copiar código de convite” continua disponível diretamente no menu, com confirmação visível. A cópia no app instalado usa o clipboard nativo do Electron; em caso de falha, o texto permanece selecionável para cópia manual.
- Criar canais de texto/voz usa formulário interno em vez de `window.prompt`, indisponível neste fluxo do Electron. A janela de configurações do servidor recebeu feedback de salvamento e estado de carregamento.
- `npm.cmd test` passou 18/18, o build de produção passou e `client/scripts/smoke-menu.cjs` passou no Electron usando dados fictícios para convite, mensagem pronta, criação de canais de texto/voz e abertura de configurações. O teste não modificou servidores reais; ainda falta teste real com duas pessoas para voz/transmissão.
- O commit `71bf43a` foi enviado a `master`. A release pública [Astralis 1.3.9](https://github.com/jaozinisbad/astralis/releases/tag/v1.3.9) contém instalador Windows, blockmap e `latest.yml`, confirmados pela API do GitHub; a tag aponta para `71bf43a`, não é rascunho nem pré-lançamento.
- `client/release/Astralis Setup 1.3.9.exe` foi instalado para todos os usuários. O `package.json` embutido em `C:\Program Files\Astralis\resources\app.asar` confirma 1.3.9 e o aplicativo foi aberto.
- O Render fez deploy automático do commit `71bf43a` como `dep-daslu3gu01pc73f66j10`, status `live`; `GET /health` respondeu `{"status":"ok"}`. O código do servidor e o schema Neon não mudaram nesta release.
- Alterações locais preexistentes da raiz (`neon.ts`, `package.json`, `package-lock.json`, `.agents/`, `skills-lock.json`) não foram incluídas no commit nem na release. Este arquivo de contexto permanece local para retomada.

## Teste com Codex Teste em 27/09/2026

- O usuário forneceu um convite válido do servidor Fodinhas. A sessão de teste anterior havia se perdido na troca de agente, então foi criada uma nova conta “Codex Teste” (ID 13); ela entrou no servidor (ID 4) e no canal de voz “Sala de voz” (ID 8). Não registrar o código de convite ou credenciais neste documento.
- `client/scripts/live-test-peer.cjs` é um roteiro local **não publicado** que abre uma instância isolada do Electron com perfil separado em AppData. Ela usa microfone falso, sem acessar o microfone real do usuário, e envia uma tela e um tom gerados para testar vídeo e volume. O cliente de teste e o observador Socket.IO viram “jaozinisbad” e “Codex Teste” na chamada; a interface indicou voz conectada e transmissão ativa sem erro.
- O arquivo temporário `client/release/codex-test-session.json` foi consumido e apagado imediatamente pelo roteiro. A sessão da conta de teste persiste apenas no perfil isolado do AppData. O usuário confirmou que o teste funcionou e pediu para sair; o processo isolado de “Codex Teste” foi encerrado, sem afetar o Astralis instalado do usuário. Foi verificado que não restaram processos do roteiro nem o arquivo temporário.

## Correção do áudio da transmissão e release 1.3.10 em 27/09/2026

- A amiga do usuário relatou que continuou ouvindo o áudio da transmissão depois de silenciá-la e fechar o vídeo. A causa era o áudio da tela tocar em elemento separado que não acompanhava a visualização, enquanto o controle geral de silêncio só afetava vozes.
- O cliente agora toca áudio da tela somente quando a respectiva transmissão está aberta. Fechar, trocar de tela, silenciar aquela transmissão ou silenciar o áudio geral interrompe esse som. O áudio da tela também é classificado corretamente quando sua faixa chega antes do vídeo.
- `npm.cmd test` passou 20/20; o build passou. O instalador `client/release/Astralis Setup 1.3.10.exe` foi gerado e o `app.asar` embutido confirmou 1.3.10. Commit `2788bf2` e tag `v1.3.10` enviados a `master`; a [release pública 1.3.10](https://github.com/jaozinisbad/astralis/releases/tag/v1.3.10) foi confirmada sem rascunho ou pré-lançamento, com EXE, blockmap e `latest.yml`. Ainda falta teste da correção com duas pessoas nas versões novas.
- O app 1.3.9 permaneceu aberto no computador do usuário, por isso a instalação local não foi substituída durante a chamada. Os arquivos locais preexistentes da raiz foram preservados.

## Recuperação assistida de conta e release 1.3.11 em 27/09/2026

- Amigos esqueceram e-mail e senha. A senha antiga não pode ser recuperada do hash bcrypt. O suporte local `npm.cmd run suporte:contas -- buscar <nome>` encontra `id`, nome e e-mail; `... gerar <id>` exige confirmação manual e emite código aleatório de uso único com validade de 20 minutos. O código é guardado apenas como SHA-256 no Neon e deve ser enviado privadamente após confirmar a identidade da pessoa por outro contato.
- Na nova tela “Esqueceu a senha?”, a pessoa informa e-mail, código e nova senha. O backend não revela se o e-mail existe, limita tentativas por IP e só consome o código válido na mesma instrução SQL que troca o hash da senha. A versão da sessão sobe para invalidar JWTs antigos, e os sockets registrados no serviço atual são desconectados. O guia operacional é `docs/SUPORTE-CONTAS.md`.
- `npm.cmd test` passou **16/16** no servidor e **21/21** no cliente; `npm.cmd run build` passou. O `app.asar` do instalador local confirmou 1.3.11. Commit `f6f1f85` e tag `v1.3.11` foram enviados ao GitHub; a [release pública 1.3.11](https://github.com/jaozinisbad/astralis/releases/tag/v1.3.11) foi confirmada com EXE, blockmap e `latest.yml`, sem rascunho/pré-lançamento.
- O Render fez deploy automático `dep-dasqi1jtqb8s73a2qg1g`, status `live`; `/health` respondeu `ok`. Consulta de esquema somente leitura confirmou `usuarios.versao_sessao` e a tabela `recuperacoes_senha` na branch Neon `production`, sem consultar dados de usuários. A versão instalada no computador do usuário era 1.3.10 e o app continuava aberto; 1.3.11 está disponível para atualizar. Nenhuma conta foi redefinida nesta etapa.

## Prompt para colar na IA do VS Code

> Continue o Astralis na pasta `C:\Users\User\Documents\ChatGPT\app para gamers\astralis`. Leia `docs/CONTEXTO-RETOMADA.md`, `docs/SUPORTE-CONTAS.md`, `docs/render.md` e `README.md`. Preserve dados e segredos; mantenha custo zero e app desktop. A release pública 1.3.11 (commit `f6f1f85`) oferece recuperação assistida por código temporário: o dono localiza a conta no Neon, confirma por outro contato que é o titular, gera um código com `npm.cmd run suporte:contas -- gerar <id>` na pasta `server` e envia e-mail/código em privado. A pessoa usa “Esqueceu a senha?” para definir outra senha; não há como ver a antiga. O Render está `live`, `/health` respondeu `ok`, e o schema foi confirmado em Neon `production`. Os testes passaram 16/16 servidor e 21/21 cliente; nenhuma conta foi alterada. A versão instalada no computador do usuário ainda era 1.3.10, aberta; atualizá-la após o uso e testar com conta de teste. Preserve alterações locais preexistentes da raiz e não execute migração destrutiva do Neon. Atualize este arquivo ao fim da próxima fase.
