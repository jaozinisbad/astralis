const URL_PUBLICA = 'https://app-gamers-server.onrender.com';
// A prévia local também usa a API publicada por padrão. Para desenvolver com
// um backend local, defina VITE_SERVER_URL=http://localhost:3001.
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || URL_PUBLICA;

export async function apiFetch(caminho, token, opcoes = {}) {
  const resp = await fetch(`${SERVER_URL}${caminho}`, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      // Faz o ngrok (plano grátis) pular a página de aviso de navegador.
      'ngrok-skip-browser-warning': 'true',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opcoes.headers || {}),
    },
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const sessaoInvalida = resp.status === 401 || (
      resp.status === 403 && dados.erro === 'Token inválido ou expirado.'
    ); // Compatibilidade com versões antigas do backend.
    const erro = new Error(dados.erro || (sessaoInvalida
      ? 'Sua sessão expirou. Entre novamente.'
      : resp.status === 403 ? 'Você não tem permissão para esta ação.' : 'Erro ao falar com o servidor.'));
    erro.status = resp.status;
    // Apenas uma chamada que enviou credenciais pode invalidar a sessão.
    // 403 também é usado para negar permissões e deve preservar o login.
    if (token && sessaoInvalida) {
      localStorage.removeItem('sessao');
      window.dispatchEvent(new Event('sessao-invalida'));
    }
    throw erro;
  }
  return dados;
}
