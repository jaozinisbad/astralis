<p align="center">
  <img src="client/public/astralis-mark.svg" alt="Logo Astralis" width="128" height="128" />
</p>

<h1 align="center">Astralis</h1>

<p align="center">Compartilhe sua tela e assista junto com seus amigos, no computador ou no celular.</p>

<p align="center">
  <a href="https://astralis-b2w.pages.dev">Abrir no navegador</a> ·
  <a href="https://github.com/jaozinisbad/astralis/releases/latest">Baixar para Windows</a>
</p>

## O que é o Astralis

Astralis é um app de salas para compartilhar tela e assistir a vídeos do YouTube em grupo. Você transmite pelo computador, e seus amigos podem assistir pelo app Windows ou pelo navegador, inclusive no iPhone e no Android.

As salas são focadas no conteúdo compartilhado: não têm chamada de voz nem chat. Para conversar durante a transmissão, continuem usando o Discord.

## Começar a usar

### No Windows

1. Abra a [release mais recente](https://github.com/jaozinisbad/astralis/releases/latest).
2. Baixe e execute o instalador `Astralis-Setup-<versão>.exe`.
3. Abra o Astralis e entre na sua conta, ou crie uma conta na tela de cadastro.
4. Crie uma sala ou entre na sala de um amigo.

O aplicativo consulta novas versões ao iniciar e enquanto permanece aberto. Quando houver uma atualização, clique em **Baixar atualização** para iniciar o download e acompanhar o progresso. Depois, clique em **Reiniciar e instalar** quando puder interromper o uso. Fechar ou reabrir o Astralis não instala a atualização automaticamente; você pode adiar sem sair da conta. Se houver uma falha, o aviso permite tentar novamente a etapa que falhou. Você também pode atualizar pelo instalador da release mais recente.

### No navegador e no celular

Abra [astralis-b2w.pages.dev](https://astralis-b2w.pages.dev). Você pode entrar nas salas como visitante, sem criar uma conta. Para criar uma sala, entre na sua conta. Visitantes também podem compartilhar tela em um computador compatível quando houver uma vaga livre de transmissão.

No iPhone ou Android, abra o link recebido pelo navegador. O uso no celular é voltado a assistir; para compartilhar a tela, use um computador com o app Windows ou um navegador que ofereça captura de tela.

## Criar uma sala e convidar amigos

1. Entre na sua conta e, no painel **Crie sua sala**, informe o **Nome da sala**.
2. Escolha quem pode assistir:

   - **Pública:** aparece na lista de salas públicas quando há uma transmissão de tela ativa.
   - **Privada:** a entrada exige o código de acesso e a sala fica fora da lista pública.

3. Clique em **Criar sala**.
4. Com a sala aberta no site ou no app Windows, use **Copiar link** para enviar o convite. O link de uma sala privada já inclui o código de acesso; compartilhe-o somente com as pessoas que você quer convidar.

Para entrar em uma sala privada sem o link, use **Entrar com código de convite** na tela inicial e digite somente o código. Não é necessário informar o ID da sala.

Se preferir, compartilhe apenas o código privado. Seus amigos entram pela opção **Entrar com código de convite**.

O anfitrião é quem criou a sala. Ele pode encerrá-la para todos; os demais participantes podem sair sem encerrar a sala. Para o anfitrião, voltar por **← Salas** também encerra a sala.

Uma sala pública aguardando conteúdo ou reproduzindo apenas YouTube não aparece na lista de transmissões de tela ao vivo. Nesse caso, compartilhe o link para convidar amigos.

## Compartilhar tela

1. Dentro da sala, clique em **Compartilhar tela**, no palco ou na barra inferior.
2. No app Windows, escolha o monitor ou a janela. No navegador, mantenha a opção **Tela ou janela**.
3. Configure a qualidade e decida se deseja **Compartilhar o áudio da tela**.
4. Clique em **Compartilhar**. No navegador, escolha a fonte no seletor que aparecer; autorize a captura quando solicitado.
5. Ao terminar, use **Parar transmissão** ou o botão de parar compartilhamento na barra inferior.

Qualquer participante, inclusive visitante, pode transmitir quando houver uma vaga livre. A sala aceita **até duas transmissões de tela simultâneas**; uma terceira pessoa precisa aguardar alguém parar. Cada transmissor controla somente a própria tela. Parar o compartilhamento mantém a sala e a outra transmissão abertas.

### Qualidade da transmissão

O padrão solicita **1080p, 60 fps e até 16 Mbps por espectador**. No seletor de compartilhamento, você pode ajustar:

| Opção | Valores disponíveis |
| --- | --- |
| Resolução | 576p, 720p e Full HD (1080p) |
| Taxa de quadros | 15, 24, 30 e 60 fps |
| Bitrate máximo | Aproximadamente 700 Kbps, 2, 4, 8 e 16 Mbps |
| Tipo de conteúdo | Texto / código, para nitidez; Vídeo / jogo, para fluidez |
| Qualidade inteligente | Divide o limite de bitrate entre os espectadores para poupar upload |

Para jogos com bastante movimento, escolha **Vídeo / jogo**. Se a transmissão travar ou ficar borrada, experimente reduzir o bitrate, a resolução ou a taxa de quadros.

Os valores são limites solicitados, não uma garantia de qualidade. A transmissão depende do upload de quem compartilha, da conexão dos espectadores e da capacidade dos aparelhos. Sem qualidade inteligente, o consumo de upload cresce com cada espectador.

### Áudio da tela e do Discord

O áudio da tela é opcional e sua disponibilidade varia conforme a fonte, o navegador e o sistema operacional. O Astralis não usa o microfone como chamada de voz dentro da sala.

Ao compartilhar um monitor pelo app Windows, existe a opção experimental **Não enviar o áudio do Discord aos espectadores**. Ela tenta excluir o Discord do áudio transmitido, mantendo a conversa audível no seu computador. Se o filtro falhar, a captura continua sem áudio do sistema para evitar enviar a conversa.

## Assistir a uma transmissão

Entre pela lista de salas públicas, pelo link de convite ou pelo código de uma sala privada. As transmissões aparecem em miniaturas no canto superior esquerdo da sala. Clique ou toque em uma miniatura para ampliá-la no palco; quando houver duas, você pode alternar entre elas sem sair da sala.

A transmissão selecionada começa silenciada. Use **Ativar áudio** para ouvir o som compartilhado. As miniaturas e a transmissão que não estiver selecionada ficam sempre sem áudio; ao trocar de vídeo, o novo também começa silenciado para evitar sobreposição. Os controles do player permitem ajustar o volume onde o navegador oferece suporte, abrir uma janela flutuante (picture-in-picture), entrar em tela cheia e **Parar de assistir**. Esse último controle volta à seleção de transmissões sem sair da sala. Não há botão de pausa para a transmissão ao vivo.

Se aparecer **Iniciar vídeo**, toque nesse botão para liberar a reprodução. No iPhone, o volume é controlado pelos botões do aparelho; a tela cheia da transmissão pode usar o player nativo do Safari, com os controles do iOS. A janela flutuante depende do suporte do navegador.

## Assistir ao YouTube junto

1. Quem estiver transmitindo deve parar o compartilhamento de tela antes de o anfitrião adicionar um vídeo.
2. Clique em **Adicionar fonte de vídeo** no palco ou no botão do YouTube da barra inferior.
3. Cole o link de um vídeo do YouTube e clique em **Adicionar vídeo**.
4. Todos os participantes podem reproduzir, pausar e mudar a posição do vídeo. Esses comandos são sincronizados com a sala.
5. Para voltar ao compartilhamento de tela, o anfitrião usa **Remover vídeo da sala**.

Cada aparelho reproduz o vídeo diretamente do YouTube, sem retransmitir uma captura de tela. A qualidade continua sendo definida pelo YouTube e pela conexão de cada pessoa. Também é possível usar o link de um vídeo de música nesse mesmo fluxo; não há um tocador de música separado.

Há uma fonte do YouTube por sala, gerenciada pelo anfitrião. Vídeos que bloqueiam reprodução incorporada podem não abrir. No celular, pode ser necessário um toque para iniciar a reprodução.

## Quando algo não funcionar

- **O servidor demorou para responder:** aguarde alguns instantes e tente novamente. O backend no plano gratuito do Render pode precisar retomar após ficar sem uso.
- **Código inválido ou sala encerrada:** confirme o código com o anfitrião. Se ele encerrou a sala, será necessário criar outra.
- **Transmissão caiu:** mantenha a sala aberta enquanto o app tenta reconectar. Se a captura tiver terminado, inicie o compartilhamento novamente. A sala pode encerrar se o anfitrião não recuperar a conexão.
- **Vídeo sem som:** confira o silêncio e o volume do player e verifique se quem transmite ativou o áudio da tela.
- **Conexão entre alguns amigos não funciona:** redes restritivas podem impedir a conexão direta do WebRTC. A configuração atual usa STUN e não inclui um servidor TURN.
- **Esqueceu a senha:** use a opção de recuperação na tela de login. O código temporário é fornecido pelo responsável pelo app; o procedimento de suporte está em [docs/SUPORTE-CONTAS.md](docs/SUPORTE-CONTAS.md).

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
