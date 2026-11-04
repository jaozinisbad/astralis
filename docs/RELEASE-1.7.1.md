# Astralis 1.7.1

Data: 4 de novembro de 2026.

O Astralis exige uma conta no aplicativo Windows e na versão web. Sem sessão, a tela de entrada oferece login, cadastro e recuperação de senha. Convites de sala só abrem depois da autenticação. Sessões válidas salvas no dispositivo continuam conectadas.

O servidor rejeita conexões Socket.IO sem token, inclusive no antigo modo espectador. Nenhuma conta ou mensagem é removida e não há migração de banco nesta versão.

Esta versão também incorpora o trabalho preservado no backup de 2 de novembro: toque repetido em chamadas privadas e a correção que mantém o áudio da transmissão independente do silêncio da voz.

Para atualizar no aplicativo, use **Baixar atualização** e depois **Reiniciar e instalar**, ou execute o instalador da release. O download e a instalação continuam manuais.

Validação: 103 testes do servidor, 442 testes do cliente e build web. Publicar o backend e o frontend junto com o instalador para que a exigência de conta seja aplicada em todos os acessos.
