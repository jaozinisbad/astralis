# Histórico de versões

## [1.6.0] - 2026-10-19

### Melhorias

- Nova interface com identidade roxa do Astralis, barra de servidores, canais de texto e voz, Amigos e mensagens diretas.
- Tela da chamada com participantes e controles inferiores de microfone, áudio, compartilhamento e desconexão. O painel de voz permite voltar à chamada a partir de Amigos ou de uma conversa.
- Compartilhamento iniciado pelo monitor da chamada: escolha em Aplicativos ou Telas, use Avançar, confira o canal e confirme em Transmitir ao vivo. No navegador, a escolha final da fonte ocorre no seletor de captura do próprio navegador.
- Controles para assistir, ajustar o volume, abrir em tela cheia, trocar a fonte ou parar a captura mantendo a chamada.
- Configurações de usuário organizadas por categoria, com temas Claro, Escuro e Meia-noite, aparência, acessibilidade e Voz e vídeo. A engrenagem da chamada abre diretamente as opções de voz.
- Compatibilidade com os links anteriores de salas de tela e reprodução sincronizada do YouTube.

### Correções

- Corrige o layout de login, cadastro e recuperação de senha, que era comprimido por uma coluna vazia no desktop. Os formulários acompanham o tema e permitem rolagem em janelas baixas.
- Voz conectada aparece somente depois da confirmação do servidor; estados de conexão e falha permanecem visíveis.
- A troca de fonte encerra a captura anterior quando a nova começa, e encerrar a transmissão preserva o microfone da chamada.

### Distribuição e transmissão

- Novas transmissões usam 1080p por padrão, alvo fixo de 60 FPS e qualidade adaptada à conexão, sem seletores manuais de FPS ou bitrate.
- O áudio do Discord permanece excluído. Quando não é possível isolá-lo com segurança, o compartilhamento segue sem áudio da tela.
- Download da atualização e reinício para instalar continuam dependendo da ação do usuário.

## [1.5.4] - 2026-10-09

### Melhorias
- O painel de diagnóstico da transmissão mostra resolução e FPS efetivos, bitrate, codec, RTT, perda e jitter quando o navegador fornece esses dados.
- A qualidade adaptativa evita reduzir o bitrate por uma estimativa inicial fria e só ajusta a distribuição após sinais medidos sustentados, mantendo o orçamento total escolhido.
- A captura de janela ganhou uma opção compatível com Windows 10, desativada por padrão e aplicada após reiniciar o aplicativo.

### Correções
- Falhas ou recusas na sinalização WebRTC ficam visíveis; uma tentativa sem conexão mostra estado ICE e limita as reconexões automáticas.
- Os controles e o cursor da transmissão voltam a se ocultar após inatividade em tela cheia nativa.
