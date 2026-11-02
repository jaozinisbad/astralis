# Restaurar o Astralis após a restauração do PC

Backup de código preparado em 2 de novembro de 2026 no repositório
https://github.com/jaozinisbad/astralis.

## Aplicativo atual

Esta branch preserva o aplicativo 1.7.0 e as alterações locais de áudio das
transmissões, toques de chamadas privadas e seus testes:

```powershell
git clone --branch codex/discord-hud-astralis https://github.com/jaozinisbad/astralis.git Astralis
cd Astralis
npm ci
npm ci --prefix server
npm ci --prefix client
```

Consulte o README para configurar e iniciar o servidor e o cliente.

## Site independente de download

O site tem histórico Git próprio e foi preservado em outra branch do mesmo
repositório. Clone-o separadamente:

```powershell
git clone --single-branch --branch codex/astralis-download-site-backup-2026-11-02 https://github.com/jaozinisbad/astralis.git astralis-download-site
cd astralis-download-site
npm test
npm run dev
```

Nesse projeto, `dist/` contém o código estático original e está versionado.
O pacote local `astralis-download-site-deploy.tar.gz` é uma cópia redundante
dos arquivos versionados.

## Trabalho anterior do atualizador

A branch `codex/backup-manual-updater-20261102` preserva as alterações que
estavam sem commit no worktree antigo, baseado na versão 1.5.2. Para consultar
esse trabalho sem substituir o aplicativo atual:

```powershell
git clone --single-branch --branch codex/backup-manual-updater-20261102 https://github.com/jaozinisbad/astralis.git Astralis-atualizador-antigo
```

É uma cópia histórica de trabalho; não deve ser usada como versão mais recente
do aplicativo. O backup não cria uma release nem publica um instalador.

## Configuração privada e arquivos regeneráveis

Os arquivos `.env.local`, `.neon` e `server/.env` contêm configuração privada,
continuam ignorados e não são enviados ao GitHub. Para conservar as credenciais
locais, guarde-os em armazenamento privado fora deste PC antes da restauração,
preservando seus caminhos, ou recupere a configuração nos serviços depois.

Dependências, builds, instaladores e capturas locais de teste são regeneráveis
e não fazem parte deste backup de código. O Git não copia o banco de dados
remoto, as contas de hospedagem nem as conversas do Codex.
