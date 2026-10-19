# HUD Astralis com organização do Discord

## Objetivo autorizado

Reproduzir a disposição da interface desktop e das configurações do Discord no Astralis, usando a logo Astralis e uma paleta roxa. Reativar na navegação as funções reais de servidores, canais, amigos, mensagens e voz que já existem no cliente e servidor.

## Estrutura

- Barra superior compacta, trilho de servidores de 72 px, navegação lateral de 256 px, conteúdo central e membros de 240 px quando o canal estiver aberto.
- Página inicial com Amigos, mensagens diretas e Salas de tela; navegação disponível também durante carregamento ou falha do serviço.
- Configurações com navegação por categorias, busca, conta/perfil e controles persistentes de aparência, acessibilidade, comunicação, mensagens e notificações.
- Uso da logo existente e superfícies planas em roxo escuro; destaque violeta e temas locais alternativos.
- Recursos dependentes do serviço continuam com as APIs e permissões do Astralis. Nenhum botão simula uma função inexistente.

## Divisão

1. Agente de configurações: SettingsModal, preferências e seus testes.
2. Agente de HUD: trilho, canais, tokens e estilos globais.
3. Agente social: mensagens, DMs, amigos, busca e composer.
4. Integração principal: App, navegação inicial, dock de usuário, janela Electron, validação visual/funcional e compilação local.

## Verificação e entrega

Preservar a implementação de transmissão já presente no workspace e os contratos de autenticação, áudio protegido e atualização manual. Executar regressões e verificações reais de navegação, mensagens, configurações persistentes e layouts desktop/375 px. Gerar uma compilação local identificada como prévia da HUD, sem publicação nem instalação sobre o aplicativo existente.

## Premissas

A referência é o cliente desktop do Discord. A equivalência solicitada é de organização e experiência da interface; integrações externas, pagamentos e serviços exclusivos do Discord não serão apresentados como serviços implementados pelo Astralis. O repositório de destino é C:\Users\jaozin\Documents\Astralis.

## Publicação oficial

Em 19/10/2026, após a correção do formulário de login na prévia, o usuário autorizou publicar oficialmente esta entrega como Astralis 1.6.0. A promoção usa a versão estável, os arquivos do atualizador no GitHub Releases e a branch de produção do site.
