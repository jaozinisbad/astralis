# Astralis 1.5.6: piscadas na transmissão de janelas

## Relato investigado

Jogo em modo janela, selecionado como janela no compartilhamento. O relato
posterior confirmou que as piscadas também ocorrem com a imagem parada.
A gravação de celular mostra apagões curtos, alguns parciais e retangulares,
com o cursor preservado. Ela não permite identificar o player do Astralis
nem distinguir captura, codificação e composição da imagem.

## Defeitos reproduzidos e corrigidos

### Reinicialização indevida do vídeo nos canais de voz

O callback de ref de `VoiceChannel` atribuía o mesmo `MediaStream` a
`video.srcObject` a cada renderização. No Chromium usado pelo aplicativo,
essa atribuição reinicia o carregamento do elemento.

Em duas execuções H264 com a mesma cadência de atualização de 200 ms:

| Medida | Antes | Após a verificação de identidade |
| --- | ---: | ---: |
| Atribuições redundantes | 179 | 0 |
| Eventos `emptied` | 179 | 0 |
| Reinícios de `currentTime` | 172 | 0 |
| Erros de reprodução | 2 | 0 |

As 34 amostras sem imagem pronta após o ajuste pertencem à inicialização;
não houve novos eventos `emptied`. As sondagens de pixels das faixas de
vídeo não encontraram quadros pretos nesses ensaios. Isso distingue as
interrupções do elemento de vídeo de imagens pretas recebidas pela rede.

A alteração atribui `srcObject` somente quando o stream muda. A regressão
React falha no código anterior e verifica renderizações repetidas, parada,
nova captura e manutenção do preview silenciado. Outra regressão protege
o player de `StreamRoom` contra reassociação durante atualização de estado,
diagnóstico e eventos repetidos de faixas.

### Retorno da captura legada para a moderna

O processo principal chamava `removeFeatureFromSwitchArgs` sem importar a
função. Desativar a captura legada salvava a preferência, mas falhava no
callback de reinício com `ReferenceError`. O import foi corrigido.

O teste executa o código real do processo principal com dependências
isoladas, invoca o IPC e o callback agendado, verifica persistência,
argumentos de reinício e remoção apenas de `AllowWgcWindowCapturer`.
Ler a configuração ou manter a seleção atual não agenda um reinício.

## Captura de jogos e modo legado

A captura moderna é o padrão. Uma preferência legada existente continua
sendo uma escolha do usuário. O seletor agora identifica essa alternativa
como experimental e orienta desativá-la se houver tela preta ou piscadas.
A aplicação da mudança continua no botão explícito de reinício.

No Chromium 126, desativar WGC pode usar recorte da captura de monitor ou
GDI/`PrintWindow`, dependendo de visibilidade, sobreposição e geometria.
O próprio código do capturador GDI documenta incompatibilidades e flicker.
Isso torna o modo legado uma hipótese pertinente, sem comprovar a causa
da gravação fornecida.

Fontes primárias:

- [Seleção do capturador no libWebRTC 126](https://webrtc.googlesource.com/src/+/a18e38fed2307edd6382760213fa3ddf199fa181/modules/desktop_capture/desktop_capturer.cc)
- [Condições de recorte de janela](https://webrtc.googlesource.com/src/+/a18e38fed2307edd6382760213fa3ddf199fa181/modules/desktop_capture/cropping_window_capturer_win.cc)
- [Implementação GDI e limitações](https://webrtc.googlesource.com/src/+/a18e38fed2307edd6382760213fa3ddf199fa181/modules/desktop_capture/win/window_capturer_win_gdi.cc)
- [Contrato de PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)

## Validação e limites

- `cd client; npm test`: 313 testes aprovados.
- `cd server; npm test`: 73 testes aprovados.
- `cd client; npm run build`: build de produção aprovado.
- VP8 e H264 reais em Electron, com aceleração gráfica habilitada,
  transmissão local e limites de 16, 4, 0,7 e 16 Mbps.
- Comparação de captura moderna e legada com alvos próprios WebGL,
  Direct3D 9 e Direct3D 11, incluindo sobreposição por janela de teste.
- Revisão independente das mudanças e regressões.

Os ensaios usam sondagens de pixels em quadros entregues por
`MediaStreamTrackProcessor`, além dos eventos do elemento de vídeo.
O alvo de captura permanece em 60 FPS; não equivale a uma garantia de
60 quadros entregues sob qualquer carga, conexão ou conteúdo.

O jogo do relato não estava aberto para reprodução direta. Os testes
sintéticos e a correção do player não provam que todos os apagões da
gravação tenham a mesma causa. Nenhuma preferência do perfil real foi
alterada durante a investigação, e o aplicativo instalado não foi reiniciado.

## Ensaios de captura nativa

Foram capturadas somente janelas sintéticas próprias, sem áudio, em perfis
temporários isolados. O runtime foi Electron 31.7.7 / Chromium
126.0.6478.234 no Windows 10 19045, com composição, WebGL e codificação por
GPU habilitados. O dispositivo NVIDIA informou driver 32.0.16.1742.
As restrições reproduziram a janela do aplicativo: `getUserMedia` com
`chromeMediaSource: desktop`, fonte exata, 1920 x 1080 e alvo de 60 FPS.

Cada execução durou 18 segundos e amostrou os quadros de uma cópia da faixa
com `MediaStreamTrackProcessor`, antes de qualquer codificação WebRTC.
O interior da imagem foi reduzido a 96 x 54 para leitura de pixels. Preto
significa média RGB abaixo de 8; o limiar de região parcial foi 10% dos
pixels, e o de quadro inteiro foi 99,5%. Os alvos desenhavam cores claras,
com uma fase estática seguida por animação; os alvos nativos chamavam
somente a API de GPU e não pintavam o conteúdo por GDI.

| Alvo próprio | Modo legado: quadros / pretos / parciais | WGC: quadros / pretos / parciais |
| --- | ---: | ---: |
| WebGL, uma execução por modo | 1.050 / 0 / 0 | 978 / 0 / 0 |
| Direct3D 9 HAL, uma sobreposição e retirada | 1.019 / 0 / 0 | 692 / 0 / 0 |
| Direct3D 11, `FLIP_DISCARD`, três execuções por modo | 2.910 / 0 / 1 | 2.066 / 0 / 0 |

As três execuções Direct3D 11 usaram, respectivamente, 1, 4 e 15 ciclos de
sobreposição por outra janela sintética. Na primeira execução legada,
um quadro teve 38,696% dos pixels interiores pretos, aos 11,826 segundos,
durante a retirada da sobreposição. As 1.890 amostras das duas repetições
legadas seguintes não repetiram a região preta. Não foi salvo um PNG desse
primeiro evento; o registro preservado é a medição por quadro. O único
evento não permite determinar se a origem foi o capturador nativo ou a
conversão/leitura posterior do quadro, nem comprovar a causa do jogo.

Os logs do Chromium confirmaram `allow_wgc_window_capturer: 0` no ensaio
legado e `1` no moderno, mantendo `allow_wgc_screen_capturer: 0` nos dois.
O WGC emitiu erros recuperáveis `ProcessFrame failed, using existing frame`
em alguns testes; suas sondagens não encontraram regiões pretas. Não foi
alterado o padrão de captura nem migrada a preferência legada existente.

As fontes, executáveis de teste e registros locais estão em
`%TEMP%\astralis-motion-capture-20261015`. Registros principais:

- `gdi-gum-1792134712660.json` e `wgc-gum-1792134748024.json`: WebGL.
- `d3d9-gdi-gum-1792134896544.json` e
  `d3d9-wgc-gum-1792134981023.json`: Direct3D 9.
- `d3d11-gdi-gum-1792135033051.json`: evento parcial observado.
- `d3d11-gdi-gum-1792135144490.json` e
  `d3d11-gdi-gum-1792135244707.json`: repetições legadas.
- `d3d11-wgc-gum-1792135075457.json`,
  `d3d11-wgc-gum-1792135170699.json` e
  `d3d11-wgc-gum-1792135279818.json`: comparações WGC.

O total foi 8.715 quadros amostrados, sem quadros inteiramente pretos e com
a única região parcial descrita acima. O jogo do relato não estava aberto.
Esses números validam os cenários sintéticos e os limites da investigação;
não constituem confirmação da resolução das piscadas no jogo real.
