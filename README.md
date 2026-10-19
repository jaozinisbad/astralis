<p align="center">
  <img src="client/public/astralis-mark.svg" alt="Logo Astralis" width="128" height="128" />
</p>

<h1 align="center">Astralis</h1>

<p align="center">Reúna seus amigos em servidores, converse por texto e voz e compartilhe sua tela.</p>

<p align="center">
  <a href="https://astralis-b2w.pages.dev">Abrir no navegador</a> ·
  <a href="https://astralis-b2w.pages.dev">Baixar para Windows</a>
</p>

## O que é o Astralis

Astralis é um aplicativo para conversar com amigos em servidores e canais de texto e voz. A versão **1.6.0**, de **19/10/2026**, traz uma interface com identidade roxa, tela de chamada com participantes, mensagens diretas e compartilhamento de tela iniciado dentro da chamada.

O aplicativo usa contas e serviços próprios do Astralis. Os temas Claro, Escuro e Meia-noite e as preferências de aparência, acessibilidade, chat e áudio podem ser ajustados nas configurações.

## Começar a usar

### No Windows

1. Abra o [site do Astralis](https://astralis-b2w.pages.dev) e clique em **Baixar para Windows**. O site encontra o instalador da versão estável mais recente e inicia o download diretamente.
2. Execute o instalador `Astralis-Setup-<versão>.exe` e abra o Astralis.
3. Entre na sua conta ou use **Criar conta** na tela de entrada.
4. Use o botão **+** na barra de servidores para criar um servidor ou **Entrar com convite** usando o código recebido.
5. Selecione um canal de texto para conversar ou um canal de voz para entrar na chamada.

O aplicativo consulta novas versões ao iniciar e enquanto permanece aberto. Quando houver uma atualização, clique em **Baixar atualização** para iniciar o download e acompanhar o progresso. Depois, clique em **Reiniciar e instalar** quando puder interromper o uso. Fechar ou reabrir o Astralis não instala a atualização automaticamente; você pode adiar sem sair da conta. Se houver uma falha, o aviso permite tentar novamente a etapa que falhou. Você também pode atualizar pelo instalador da release mais recente.

### No navegador e no celular

Abra [astralis-b2w.pages.dev](https://astralis-b2w.pages.dev) para usar a versão web. Para conversar nos servidores, acessar mensagens diretas e entrar em chamadas, use sua conta do Astralis e permita o acesso ao microfone quando solicitado.

O compartilhamento depende do suporte de captura do navegador. No iPhone e no Android, o uso é voltado a acompanhar o conteúdo disponível; para transmitir a tela, use o aplicativo Windows ou um navegador de computador compatível. Os links antigos de salas continuam oferecendo o acesso de espectadores descrito abaixo.

## Amigos, servidores e conversas

- **Amigos:** abra o ícone Astralis no topo da barra lateral. As pessoas que compartilham um servidor com você aparecem nessa lista; use **Online**, **Todos** e a busca para encontrá-las.
- **Mensagens diretas:** selecione uma pessoa em Amigos ou uma conversa na lista lateral para abrir o chat privado.
- **Servidores:** selecione o ícone do servidor na barra lateral. O botão **+** permite criar um servidor ou entrar pelo código de convite.
- **Canais:** os canais de texto e de voz ficam agrupados dentro do servidor. As opções de criação, convite, cargos e membros dependem das suas permissões.

Para convidar alguém, abra o menu do servidor e use **Convidar para o servidor** ou **Copiar código de convite**. O convidado usa esse código em **Entrar com convite**.

## Entrar na chamada e compartilhar tela

1. Abra um servidor e selecione um **canal de voz**. Se aparecer **Conectar à voz**, clique nesse botão e permita o microfone. Aguarde o painel indicar **Voz conectada**.
2. Na tela da chamada, clique no **monitor** da barra inferior. Você também pode usar **Compartilhar tela** no painel de voz inferior esquerdo.
3. No Windows, escolha uma janela em **Aplicativos** ou um monitor em **Telas** e clique em **Avançar**. No navegador, selecione **Escolher no navegador** e avance; a escolha final da tela, janela ou aba será feita pelo próprio navegador depois da confirmação.
4. Confira a fonte, o canal, a qualidade e a opção **Compartilhar áudio**.
5. Clique em **Transmitir ao vivo**. No navegador, autorize a fonte no seletor que aparecer.
6. Para encerrar a captura, use **Parar compartilhamento de tela**. A chamada de voz continua conectada.

A tela da chamada mostra os participantes e identifica quem está **AO VIVO**. Clique em **Assistir** para abrir uma transmissão; o player oferece volume, silêncio, tela cheia e retorno aos participantes. Sua própria transmissão pode ser aberta por **Ver sua tela**.

Enquanto transmite, use **Trocar fonte de compartilhamento** no painel de voz ou **Trocar tela ou janela** no menu ao lado do monitor. A captura anterior é encerrada quando a nova fonte começa. Os controles de microfone, áudio e desconexão ficam na barra inferior da chamada. Abrir Amigos ou uma mensagem direta mantém a chamada; clique no nome do canal no painel de voz para voltar a ela. **Desconectar da chamada** encerra a conexão de voz e a sua transmissão.

### Qualidade e áudio

Novas transmissões começam em **Full HD (1080p)**, a maior resolução disponível, com alvo fixo de **60 FPS** e ajuste automático de qualidade. Você pode escolher 576p, 720p ou 1080p. Em **Opções avançadas**, ajuste a adaptação à conexão e a prioridade para **Vídeo e jogos** ou **Texto e código**. A taxa de quadros e o bitrate não têm seletores manuais.

Os valores são limites solicitados. A resolução e a fluidez entregues dependem do computador, do upload, da conexão dos participantes e do suporte de captura. O compartilhamento de tela usa WebRTC entre os participantes.

O áudio da fonte é opcional. O **áudio do Discord fica sempre excluído**: no Windows, a captura usa isolamento por processo quando disponível. Se não for possível excluir o Discord com segurança, inclusive no navegador, o compartilhamento segue **sem áudio da tela**. Sua voz usa o microfone da chamada e possui controles próprios.

O filtro de áudio reconhece Discord, PTB, Canary e Development e usa os processos identificados ao iniciar a captura. Se você reiniciar o Discord ou abrir outra instância independente enquanto transmite, pare e inicie novamente o compartilhamento para atualizar a exclusão.

A opção **Captura legada sem borda (experimental)** fica disponível para janelas no aplicativo Windows. Alterar o modo de captura pode exigir reiniciar o Astralis, encerrando chamadas e transmissões em andamento. Consulte os [detalhes e limites da captura de janelas](docs/WINDOW-CAPTURE-1.5.6.md).

## Personalizar o Astralis

Abra **Configurações de usuário** pela engrenagem da barra inferior. Em **Aparência**, escolha **Claro**, **Escuro** ou **Meia-noite**, a densidade das mensagens e o tamanho da fonte. Em **Acessibilidade**, ajuste contraste e movimento. Use **Salvar alterações** quando a faixa de alterações pendentes aparecer.

**Voz e vídeo** reúne microfone e saída de áudio, volumes, teste local de microfone e perfis de processamento de voz. O botão de configurações dentro da chamada abre essa categoria. As preferências da interface ficam neste dispositivo.

## Links e salas de tela anteriores

Os convites de salas anteriores continuam funcionando. Abra o link recebido ou o [acesso às salas](https://astralis-b2w.pages.dev/?view=salas). Esse recurso mantém o fluxo anterior de salas públicas e privadas, espectadores visitantes e reprodução sincronizada do YouTube; a navegação principal da nova interface usa Amigos, servidores e canais.

Na área de salas, você pode criar uma sala ao entrar na sua conta ou usar **Entrar com código de convite**. Salas privadas exigem o código; o link de convite pode incluir esse código, portanto compartilhe-o somente com quem você deseja convidar. Somente salas públicas com transmissão de tela ativa aparecem na lista pública. O anfitrião pode encerrar a sala para todos; os demais participantes podem sair individualmente.

As salas anteriores aceitam até **duas transmissões de tela simultâneas**. Cada pessoa controla sua própria captura. Para compartilhar, use **Compartilhar tela**, escolha a fonte, avance e confirme em **Transmitir ao vivo**. Para assistir, selecione a miniatura da transmissão e ative o áudio se desejar. No celular, pode ser necessário tocar em **Iniciar vídeo**; tela cheia, volume e picture-in-picture dependem do navegador.

Para assistir ao YouTube junto, pare as transmissões de tela e use **Adicionar fonte de vídeo**. O anfitrião adiciona ou remove o vídeo, e os participantes podem reproduzir, pausar e mudar a posição de forma sincronizada. Cada aparelho reproduz diretamente do YouTube; vídeos que bloqueiam reprodução incorporada podem não abrir. A chamada de voz dos servidores é um fluxo separado dessas salas anteriores.

## Quando algo não funcionar

- **O servidor demorou para responder:** aguarde alguns instantes e tente novamente. O backend no plano gratuito do Render pode precisar retomar após ficar sem uso.
- **A chamada não conecta:** confira a permissão de microfone, o dispositivo em **Voz e vídeo** e a mensagem de conexão antes de tentar compartilhar.
- **Vídeo sem som:** confira o silêncio e o volume do player e a opção de áudio de quem transmite. Se o isolamento do Discord não estiver disponível, a captura segue somente com vídeo.
- **Conexão entre alguns amigos não funciona:** redes restritivas podem impedir a conexão direta do WebRTC. O app aceita TURN próprio com credenciais temporárias; sem a configuração do servidor, continua usando STUN. Veja a [configuração TURN](docs/WEBRTC-TURN.md).
- **Código de sala inválido ou sala encerrada:** confirme o convite com o anfitrião. Se ele encerrou a sala, será necessário criar outra.
- **Esqueceu a senha:** use a recuperação na tela de login. O código temporário é fornecido pelo responsável pelo app; veja o [procedimento de suporte](docs/SUPORTE-CONTAS.md).

## Desenvolvimento local

Requisitos: **Node.js 22.5 ou superior**, npm e um banco PostgreSQL de desenvolvimento.

Clone o projeto e instale as dependências:

```powershell
git clone https://github.com/jaozinisbad/astralis.git
cd astralis
npm ci --prefix server
npm ci --prefix client
```

Crie `server/.env` a partir de [server/.env.example](server/.env.example). Configure `PORT=3001`, um `JWT_SECRET` longo e aleatório e `DATABASE_URL` com a conexão do banco de desenvolvimento. Para usar Neon, escolha uma conexão pooled de um ambiente de teste.

Crie `client/.env.local` com:

```dotenv
VITE_SERVER_URL=http://localhost:3001
```

Essa variável é importante: vazia ou ausente, o cliente usa o backend publicado no Render. Seu valor é público e deve conter somente a URL do backend.

Opcionalmente, defina `VITE_PUBLIC_WEB_URL` com o endereço HTTPS público do site se quiser gerar convites em outro domínio. Sem essa variável, o app Windows usa `https://astralis-b2w.pages.dev` nos links copiados.

Em um terminal, na raiz do repositório, inicie o servidor:

```powershell
npm run dev --prefix server
```

Em outro terminal, abra o cliente web:

```powershell
npm run dev --prefix client
```

Abra o endereço local informado pelo Vite. Para desenvolver no Electron, use este comando no lugar do cliente web:

```powershell
npm run dev:electron --prefix client
```

### Testes e build web

Execute na raiz do repositório:

```powershell
npm test --prefix server
npm test --prefix client
npm run build --prefix client
```

O build web é gerado em `client/dist`. Os instaladores distribuídos ficam em [GitHub Releases](https://github.com/jaozinisbad/astralis/releases). Os scripts `dist` e `release` limpam a pasta local `client/release` antes de empacotar; preserve instaladores que queira guardar antes de usá-los.

### Estrutura e hospedagem

- `client/`: React, Vite e Electron; frontend web no Cloudflare Pages.
- `server/`: Express e Socket.IO; API e sinalização no Render.
- PostgreSQL no Neon: contas e dados persistentes.
- WebRTC: transmissão de tela entre participantes, sem enviar o vídeo pelo Render.
- YouTube IFrame Player: reprodução direta dos vídeos, com estado sincronizado pela sala.

As salas são mantidas na memória do servidor: reiniciar ou publicar o backend encerra as salas existentes. Contas e dados persistidos no banco permanecem separados desse estado temporário.

Nunca envie `.env`, senhas, tokens, bancos locais ou URLs de banco com credenciais para o Git. Não execute o script de migração SQLite → PostgreSQL na produção existente: ele recria o schema e pode apagar dados.
