# Amigos e chamadas diretas

## Objetivo e decisões

Adicionar pessoas pelo nome exato ou código `nome#ID`, aceitar pedidos e
conversar, ligar e compartilhar uma tela sem participar de nenhum servidor.
O usuário autorizou implementação autônoma e divisão entre agentes.

Amizades são explícitas e persistidas no PostgreSQL. Uma amizade requer aceite
do destinatário; pedidos cruzados não aprovam a relação automaticamente.
Nomes existentes não são únicos, portanto o código com ID resolve homônimos.
Conversas antigas entre membros de um servidor continuam autorizadas.

Chamadas privadas têm duas pessoas. O destinatário aceita ou recusa; o chamador
pode cancelar. Uma pessoa ocupada ou offline recebe resposta correspondente.
Convites expiram em 30 segundos. Desconexão encerra a chamada; remover amizade
também encerra. Microfone e tela só são capturados após aceite e ação do usuário.
Uma chamada pode continuar durante navegação, com retorno pelo painel de voz.

## Contratos

- `GET /api/amigos`: amigos aceitos com presença.
- `GET /api/amigos/pedidos`: `{ recebidos, enviados }`; cada item tem `id` e `usuario`.
- `POST /api/amigos/pedidos {nome}`; `POST /api/amigos/pedidos/:id/aceitar`.
- `DELETE /api/amigos/pedidos/:id`: recusar ou cancelar; `DELETE /api/amigos/:id`: remover.
- Evento `amizades-atualizadas` atualiza as listas dos participantes.
- `chamada:iniciar {paraUsuarioId}`, `chamada:aceitar|recusar|cancelar|encerrar {callId}`.
- Respostas `{ok,call}` ou `{ok:false,code,error}`.
- `chamada:recebida` e `chamada:estado` usam `{call}`; `chamada:encerrada` usa `{callId,reason}`.
- `call`: `{id,status:'ringing'|'active',caller,callee,canalId:'direta:<id>'}`.
- Após aceite, VoiceChannel entra no canal virtual. O servidor autoriza somente
  os dois sockets escolhidos; sinalização e transmissão usam o fluxo existente.

## Divisão e verificação

- Agente de amizades: schema, API, permissões e testes de persistência/autorização.
- Agente de chamadas: ciclo de vida, sinalização, presença, testes de concorrência
  e isolamento de terceiros.
- Agente de interface: lista, formulário e pedidos responsivos, ações e testes.
- Integração principal: hooks de dados/chamada, App, conversa privada, retorno,
  seletor de tela e evidência em duas sessões locais.

Verificar rejeições, duplicatas, homônimos, remoção, chamadas ocupadas/expiradas,
múltiplas abas, respostas atrasadas, desconexão e limpeza de mídia. Executar
suítes existentes e build. Conferir o fluxo com duas contas de teste isoladas
sem servidores e layout em 375 px. Testes locais não demonstram conectividade
em todas as redes remotas; os defaults de captura e exclusão de áudio do Discord
continuam vigentes.
