# Suporte às contas do Astralis

O Astralis 1.3.11 tem recuperação assistida por código, sem e-mail automático. As contas estão na tabela `usuarios` do projeto Neon usado pelo servidor. A tabela contém `id`, `nome`, `email`, data de criação e `senha_hash`; **a senha original não pode ser lida**. O código de recuperação é gerado localmente por quem administra o banco e entregue à pessoa por um contato privado, depois de confirmar sua identidade.

## Localizar uma conta

1. Entre em [console.neon.tech](https://console.neon.tech) com a conta dona do projeto `fragrant-band-78609281`.
2. Selecione a branch **production** e abra **Tables → public → usuarios**. Confira se a branch selecionada é a de produção antes da consulta.
3. Filtre pelo nome que a pessoa usa no Astralis. Nomes podem ser repetidos; confirme também o avatar, o servidor compartilhado ou a data de cadastro. Leia apenas o e-mail da conta identificada.

Se preferir o **SQL Editor**, a consulta abaixo mostra apenas os campos necessários, sem `senha_hash`:

```sql
SELECT id, nome, email, criado_em
FROM usuarios
ORDER BY criado_em DESC
LIMIT 100;
```

Confirme a identidade da pessoa por um contato que você já conhece antes de informar o e-mail cadastrado. Evite enviar listas de contas ou e-mails em canais públicos. Os nomes de usuário não são únicos; use o `id` certo para gerar o código.

## Senha esquecida

O login usa `bcrypt`. A coluna `senha_hash` não revela a senha e não deve ser enviada a ninguém. Também não edite essa coluna diretamente no Neon: um valor errado bloquearia a conta.

Após confirmar a identidade por outro contato, abra o terminal na pasta `C:\Users\User\Documents\ChatGPT\app para gamers\astralis\server`. O comando usa a conexão configurada em `server/.env`; confira que ela aponta para a branch **production** antes de gerar o código. Não mostre nem copie esse arquivo de ambiente para outra pessoa.

```powershell
npm.cmd run suporte:contas -- buscar "apelido"
npm.cmd run suporte:contas -- gerar 12
```

Substitua `apelido` por parte do nome e `12` pelo `id` correto. O segundo comando exibe nome e e-mail para conferência e exige que você digite `GERAR 12`. Ele mostra um código aleatório **uma única vez**. Envie à pessoa, em privado, o e-mail cadastrado e o código. O código expira em **20 minutos**, só pode ser usado uma vez e não revela a senha antiga. Gerar outro código para a mesma conta invalida o anterior.

Peça à pessoa que atualize o Astralis para **1.3.11** e, na tela de entrada, clique em **Esqueceu a senha?**. Ela informa o e-mail, o código e uma senha nova de pelo menos 8 caracteres. Depois entra normalmente com a nova senha. A redefinição encerra as sessões antigas da conta no serviço atual; se outra instalação ainda estiver aberta, ela terá de entrar de novo. Servidores, mensagens e contatos permanecem na conta.

Não execute o script de migração SQLite→PostgreSQL para isso e não compartilhe o código em canais públicos ou neste chat. Se o código expirar, gere outro após confirmar de novo a conta e a identidade.
