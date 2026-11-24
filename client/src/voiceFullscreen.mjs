export async function alternarTelaCheia(elemento, documento, paginaInteira) {
  if (paginaInteira) return false;
  if (documento.fullscreenElement === elemento) {
    await documento.exitFullscreen();
    return false;
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
