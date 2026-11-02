# Astralis — site de download

Página independente do aplicativo, em HTML/CSS/JavaScript sem dependências de build.

## Desenvolvimento

Execute `npm run dev` e abra `http://127.0.0.1:4182`. Execute `npm test` para verificar a seleção de releases e os fluxos de erro/download.

## Atualizações automáticas

O site consulta `https://api.github.com/repos/jaozinisbad/astralis/releases/latest`. Versão, data, tamanho e notas vêm da release real. A consulta se repete enquanto a página está aberta, a cada cinco minutos; o clique em baixar consulta novamente antes de iniciar a transferência.

Para distribuir outra versão, publique uma release estável no repositório `jaozinisbad/astralis`, marque-a como latest e anexe o instalador Windows `Astralis-Setup-<versão>.exe`. Não é necessário editar ou republicar este site. Pushes de código, drafts e pré-releases não mudam o download estável. O cache público do GitHub pode atrasar brevemente a atualização.

O download só começa por clique. O site não instala nem executa o arquivo. Plataformas incompatíveis continuam podendo consultar as novidades e abrir o aplicativo web. Falhas de rede, indisponibilidade do instalador e limites da API são exibidos com opção de nova tentativa. Não há tokens ou credenciais no frontend.

## Hospedagem

A pasta publicada é `dist/`; a identidade do novo Site está em `.openai/hosting.json`. O aplicativo existente e suas releases não são alterados por este projeto.
