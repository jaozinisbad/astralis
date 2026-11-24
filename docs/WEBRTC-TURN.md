# Conexões WebRTC em redes restritivas

Nas salas de transmissão, chamadas privadas e canais de voz, a mídia usa uma conexão WebRTC entre participantes. Quando a rede bloqueia a conexão direta, um servidor TURN pode retransmitir o tráfego. O backend fornece a configuração aos participantes que já entraram na sala ou chamada, antes da negociação WebRTC.

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

Teste com participantes em provedores ou redes diferentes, incluindo uma rede restritiva. Nas chamadas, abra **Diagnóstico da chamada** e procure **Servidor de retransmissão (TURN)**. Nas salas, procure candidatos do tipo `relay` nos diagnósticos ICE. Confira também se a mídia volta quando a conexão WebRTC é interrompida por alguns segundos.

Referências: [TURN no WebRTC](https://webrtc.org/getting-started/turn-server) e [autenticação temporária do coturn](https://github.com/coturn/coturn/wiki/turnserver).
