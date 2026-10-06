# Publicar o frontend no Cloudflare Pages

Esta publicação hospeda somente o frontend React/Vite. O backend Express +
Socket.IO continua no Render e o PostgreSQL continua no Neon até a migração
posterior para a Oracle.

## Configuração do projeto

Ao importar o repositório no Cloudflare Pages, use:

| Campo | Valor |
| --- | --- |
| Repositório | `jaozinisbad/astralis` |
| Diretório raiz | `client` |
| Comando de build | `npm run build` |
| Diretório de saída | `dist` |
| Versão do Node | `22` |

Em **Settings → Environment variables**, configure `VITE_SERVER_URL` com
`https://app-gamers-server.onrender.com` para os builds de produção e de
pré-visualização. O cliente já usa essa URL como padrão, então a variável é
opcional enquanto o backend permanecer no Render; defini-la deixa o destino
explícito.

`VITE_SERVER_URL` é incorporada ao JavaScript público do site. Só deve conter a
URL pública do backend: nunca coloque nela senha, token privado, `JWT_SECRET`
ou `DATABASE_URL`.

## Criar o site na sua conta

1. Entre em [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Abra **Workers & Pages → Create application → Pages → Connect to Git**.
3. Autorize o acesso ao GitHub e selecione `jaozinisbad/astralis`.
4. Configure os campos da tabela acima e inicie o deploy.
5. Quando terminar, o Cloudflare mostrará o endereço público `*.pages.dev`.

O Pages publica o conteúdo que já foi enviado ao GitHub na branch escolhida;
arquivos que existem apenas neste computador não entram no deploy. Depois de
conectar o repositório, novos pushes nessa branch geram novas publicações.

## O que esta etapa não habilita

O site poderá carregar o frontend atual pelo navegador, mas o visualizador
dedicado para celular ainda precisa ser implementado. A transmissão existente
permanece acoplada ao canal de voz do aplicativo desktop e requer mudanças no
fluxo de sinalização antes de espectadores móveis poderem assistir sem entrar
em voz. Esta publicação, sozinha, não disponibiliza a transmissão no celular.
