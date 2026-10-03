# Salas de transmissão do Astralis — Design

## Objetivo

Reorganizar o Astralis como um aplicativo de salas para compartilhar e assistir telas, com uma identidade visual Astralis própria e uma hierarquia funcional inspirada em produtos de watch-together. O anfitrião transmite pelo cliente desktop; espectadores podem abrir um link no navegador do celular.

## Brief do produto

- O foco do app é compartilhar e assistir tela, não conversar.
- Não haverá chat, chamada, microfone ou transmissão de voz dentro do fluxo da sala. A comunicação continua no Discord.
- O áudio capturado da tela é opcional. No desktop Windows, a opção existente de excluir o áudio do Discord será preservada e apresentada como experimental.
- A home autenticada prioriza salas públicas ao vivo e ações claras para criar sala ou entrar por link/código.
- A sala tem um palco de vídeo, estado ao vivo, contagem de espectadores e controles de compartilhamento/convite. Não terá painel de chat.
- O seletor do anfitrião oferece somente formatos implementáveis sem recursos pagos: 576p, 720p e 1080p; 15, 24, 30 e 60 fps; até cerca de 8 Mbps; prioridade para nitidez ou movimento.
- O espectador no celular recebe uma interface responsiva de vídeo e não solicita permissão para microfone ou captura de tela.
- A aparência usa a marca, cores e componentes do Astralis. A referência é o fluxo de salas; nome, logotipo, texto e assets do Crystal não serão copiados.

## Fluxo

1. A pessoa autenticada cria uma sala pública ou privada e escolhe seu nome.
2. A sala privada recebe código de acesso; o link compartilhável aponta diretamente para a sala.
3. O anfitrião escolhe tela/janela, áudio e qualidade, inicia ou encerra o compartilhamento e pode copiar o convite.
4. Salas públicas ao vivo aparecem na home. Um espectador abre uma sala pública pelo link; uma sala privada exige o código.
5. O espectador vê a transmissão sem conta, microfone ou chat. O anfitrião encerra a sala ao sair.

## Arquitetura e limites

- Metadados e presença das salas ficam em memória no servidor existente; não se adiciona migração de banco. Uma sala deixa de existir quando o socket do anfitrião desconecta.
- O cliente desktop publica vídeo e, se selecionado, áudio de tela via WebRTC ponto a ponto. O servidor só autentica anfitriões, administra presença e retransmite sinalização; não recebe o vídeo.
- A criação de sala exige a sessão existente. A conexão de visitante sem conta é somente para descobrir/juntar-se a salas; ela não recebe handlers de chat, voz, perfil ou criação.
- Cada sinal WebRTC será autorizado pelo servidor: remetente e destinatário devem pertencer à mesma sala, e apenas o anfitrião pode ofertar mídia. A sinalização antiga de canal também precisa validar que os sockets compartilham o canal de voz.
- Links usam rota no hash para funcionar tanto no Cloudflare Pages quanto no Electron com o `base` relativo do Vite.
- STUN/WebRTC direto não garante conexão em toda rede. Sem TURN/SFU, upload do anfitrião cresce com espectadores e alguns NATs/firewalls podem impedir a conexão; isso não é resolvido pela interface.

## Fora de escopo

Chat, voz/microfone, música/YouTube, perfil social, estatísticas/conquistas, relay/SFU, TURN pago, 1440p/4K e 120/250 fps. Não se promete captura seletiva de áudio de qualquer aplicativo: o suporte existente para ignorar o Discord é Windows/Electron e experimental.

## Acessibilidade e estados

Controles serão botões/labels semânticos, operáveis por teclado e com foco visível. Sala deve distinguir conexão, aguardando anfitrião, ao vivo, erro de permissão, código inválido e anfitrião desconectado. Reprodução móvel deve usar vídeo inline e apresentar ação de reproduzir quando o navegador bloquear autoplay.

## Testes de aceite

- Salas públicas aparecem sem expor códigos privados; privadas aceitam código correto e rejeitam o incorreto.
- Só o anfitrião cria/encerra/publica mídia; sinais de sockets fora da mesma sala não são retransmitidos.
- Desconexão do anfitrião encerra a sala e notifica espectadores; saída do espectador não encerra a sala.
- A rota de espectador não pede microfone e mostra vídeo/estado com layout estreito.
- As opções de qualidade geram constraints/bitrate coerentes e o toggle de Discord só aparece no cliente Electron compatível.
- A suíte existente e os builds do cliente e do servidor continuam passando.

## Premissas adotadas para avançar sem novas perguntas

- Espectadores podem entrar anonimamente por link/código; anfitriões continuam autenticados.
- Salas e links são efêmeros: se o processo do servidor reiniciar, as salas ativas desaparecem.
- O uso previsto é um grupo pequeno de amigos; o MVP usa WebRTC direto e não oferece garantia de escala ou travessia universal de NAT.
