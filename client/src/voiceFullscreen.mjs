export async function alternarTelaCheia(elemento, documento, paginaInteira) {
  if (paginaInteira) return false;
  if (documento.fullscreenElement === elemento) {
    await documento.exitFullscreen();
    return false;
  }
  const video = elemento.querySelector?.('video');
  if ((documento.fullscreenEnabled === false || typeof elemento.requestFullscreen !== 'function')
      && typeof video?.webkitEnterFullscreen === 'function') {
    try {
      video.webkitEnterFullscreen();
      return false;
    } catch {
      // Algumas transmissões ao vivo não são aceitas pelo player nativo.
    }
  }
  if (typeof elemento.requestFullscreen === 'function') {
    try {
      await elemento.requestFullscreen();
      return false;
    } catch {
      // Alguns navegadores expõem a API, mas não permitem usá-la.
    }
  }
  return true;
}
