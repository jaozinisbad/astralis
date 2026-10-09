# Histórico de versões

## [1.5.4] - 2026-10-09

### Melhorias
- O painel de diagnóstico da transmissão mostra resolução e FPS efetivos, bitrate, codec, RTT, perda e jitter quando o navegador fornece esses dados.
- A qualidade adaptativa evita reduzir o bitrate por uma estimativa inicial fria e só ajusta a distribuição após sinais medidos sustentados, mantendo o orçamento total escolhido.
- A captura de janela ganhou uma opção compatível com Windows 10, desativada por padrão e aplicada após reiniciar o aplicativo.

### Correções
- Falhas ou recusas na sinalização WebRTC ficam visíveis; uma tentativa sem conexão mostra estado ICE e limita as reconexões automáticas.
- Os controles e o cursor da transmissão voltam a se ocultar após inatividade em tela cheia nativa.
