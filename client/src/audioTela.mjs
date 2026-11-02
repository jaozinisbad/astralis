export function sincronizarReproducaoDasTelas(audios, { telasMutadas, telaSelecionadaId }) {
  // O deafen da voz não controla o áudio próprio da transmissão.
  Object.entries(audios).forEach(([socketId, audio]) => {
    audio.muted = telasMutadas.has(socketId) || telaSelecionadaId !== socketId;
  });
}
