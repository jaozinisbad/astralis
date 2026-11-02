# Validação independente — site de download Astralis

Verificação realizada em 01/11/2026, horário de São Paulo.

## Release pública e arquivo real

- `GET https://api.github.com/repos/jaozinisbad/astralis/releases/latest`: HTTP 200, release `v1.7.0`, `draft=false`, `prerelease=false`, publicação em `2026-10-20T14:46:18Z`.
- Asset `Astralis-Setup-1.7.0.exe`: estado `uploaded`, tamanho de 86.541.045 bytes.
- `HEAD` na URL canônica do instalador, seguindo redirecionamentos: HTTP 200 em `release-assets.githubusercontent.com`, `Content-Type: application/octet-stream`, `Content-Length: 86541045` e `Content-Disposition: attachment; filename=Astralis-Setup-1.7.0.exe`.
- Não foi necessário abrir a página de releases para obter o arquivo. Nenhum instalador foi executado ou instalado durante a validação.

## Integração e segurança

- Revisão de `dist/release.mjs`: não contém versão de produção fixa; consulta o endpoint `releases/latest`.
- Rejeita drafts, pré-releases, tags de prévia, instalador ausente, arquivo vazio, upload incompleto, `.blockmap`, URLs externas, outro repositório e versão de arquivo divergente.
- Aceita somente URL exata HTTPS do repositório, tag e nome do instalador esperados.
- Notas externas são renderizadas com `textContent`, sem executar HTML/JavaScript.
- Carregamento e atualização dos metadados não iniciam download. Clique consulta novamente; falha nessa consulta não utiliza instalador antigo.
- Plataformas diferentes de Windows recebem informação sobre compatibilidade; download permanece desabilitado.
- `node --test astralis-download-site/tests/release.test.mjs`: 25 testes passaram, zero falhas.

## Revisão independente da interface

- HTML identifica português do Brasil, inclui viewport responsiva, título e descrição próprios, link para pular ao conteúdo e hierarquia semântica de títulos.
- Botões são controles nativos; estados e erros usam região `role=status` com `aria-live=polite`. Links externos incluem `noopener noreferrer`.
- Navegação e FAQ funcionam com HTML nativo, sem depender de bibliotecas externas. Conteúdo de funcionalidades foi comparado com o README do Astralis: amigos, mensagens, servidores, voz e tela.
- CSS contém composição de uma coluna no celular, quebra de notas longas, foco visível e respeito a `prefers-reduced-motion`.
- Sinalizados ao integrador: disponibilizar informação de plataforma que estava oculta; incluir nova consulta manual nas notas para usuários de outras plataformas; repetir status de erro próximo ao segundo botão de download; alinhar o FAQ à política de acesso da hospedagem.
- Verificação visual relatada pelo integrador em Windows/1440px: `v1.7.0` carregada da API real, sem overflow horizontal nem erros de página. As demais verificações no navegador são de responsabilidade da integração final.

## Atualização e limites verificados

- O endpoint público respondeu com `Access-Control-Allow-Origin: *`, permitindo consulta direta do navegador sem tokens.
- Cache público observado no GitHub: `max-age=60, s-maxage=60`; a mudança pode demorar brevemente a aparecer.
- Limite anônimo observado e documentado: 60 consultas por hora por IP. Falhas HTTP 403/429 têm mensagem de erro e nova tentativa manual.
- A página atualiza metadados a cada cinco minutos quando visível e na retomada após esse intervalo; o botão de download faz nova consulta.
- Para versões futuras, publicar uma release estável marcada como latest e anexar `Astralis-Setup-<versão>.exe`. Push de código, draft e pré-release não mudam a versão estável oferecida.

Fontes primárias: [endpoint público do Astralis](https://api.github.com/repos/jaozinisbad/astralis/releases/latest), [GitHub: latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), [GitHub: limites da API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Limites desta verificação

Esta etapa confirma metadados públicos, disponibilidade HTTP do instalador, lógica de seleção e testes de integração do módulo. A verificação visual no navegador, a publicação do novo site e o acesso ao endereço publicado ficam registrados pelo agente responsável pela integração final. Não foi feita nova validação funcional do aplicativo Astralis instalado.

## Integração final no navegador

- Chrome/Windows real: API consultada uma vez ao carregar e novamente ao clicar; zero downloads antes do clique.
- O clique gerou evento nativo de download com nome `Astralis-Setup-1.7.0.exe`, mantendo a página de download aberta. A transferência foi cancelada após comprovar o evento; o instalador não foi executado.
- Layouts inspecionados por captura em 1440, 800 e 375 px, sem overflow horizontal ou erros de JavaScript.
- Contexto Android/375px: botão desabilitado e aviso de compatibilidade visível; versão web disponível.
- HTTP 429 simulado em contexto isolado mostrou mensagem de erro; nova tentativa recuperou a versão real v1.7.0.
- Ajustes integrados: aviso visível para plataformas incompatíveis, botão manual de consulta, status junto ao CTA inferior e intervalo mínimo entre consultas automáticas.
- Artefatos locais em `evidence/` não entram no pacote publicado.
- Trabalho dividido entre integração das releases, design e auditoria independente; integração, navegador e publicação sob responsabilidade do agente principal.
