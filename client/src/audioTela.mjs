export function sincronizarReproducaoDasTelas(audios, { audioMudo, telasMutadas, telaSelecionadaId }) {
  Object.entries(audios).forEach(([socketId, audio]) => {
    audio.muted = audioMudo || telasMutadas.has(socketId) || telaSelecionadaId !== socketId;
  });
}
