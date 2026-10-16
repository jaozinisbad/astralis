# Conexões WebRTC em redes restritivas

O vídeo continua sendo enviado entre participantes. Quando a rede bloqueia a conexão direta, um servidor TURN pode retransmitir o tráfego. O backend do Astralis fornece essa configuração aos membros que já entraram na sala, antes da negociação WebRTC.

## Configuração opcional no backend

Use um servidor TURN próprio compatível com as credenciais temporárias do coturn. No coturn, configure `use-auth-secret` e um `static-auth-secret` longo e aleatório. O domínio, os certificados TLS e as portas precisam estar acessíveis aos participantes.

No ambiente do backend Astralis, defina:

```dotenv
WEBRTC_TURN_URLS=turn:turn.seu-dominio.com:3478?transport=udp,turns:turn.seu-dominio.com:443?transport=tcp
WEBRTC_TURN_SECRET=mesmo-static-auth-secret-do-coturn
```

As URLs são separadas por vírgula. Inclua TCP/TLS para redes que bloqueiam UDP. O segredo fica apenas no backend. O cliente recebe um usuário e uma senha derivados, válidos por uma hora; novas conexões atualizam a configuração em cache a cada cinco minutos. Não use variáveis `VITE_` para guardar esse segredo.

Sem essas duas variáveis válidas, o app utiliza STUN e conexão direta. O projeto não fornece nem contrata um serviço TURN automaticamente. A presença do suporte no código não confirma que um TURN esteja implantado.

## Verificação após configurar

Teste com participantes em provedores ou redes diferentes, incluindo uma rede restritiva, e confirme candidatos do tipo `relay` nos diagnósticos ICE. Um teste de vídeo na mesma máquina ou na mesma rede comprova a negociação e a entrega local; a conectividade entre redes precisa dessa verificação separada.

Referências: [TURN no WebRTC](https://webrtc.org/getting-started/turn-server) e [autenticação temporária do coturn](https://github.com/coturn/coturn/wiki/turnserver).
