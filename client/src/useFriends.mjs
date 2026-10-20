import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api.js';

const EMPTY_REQUESTS = { recebidos: [], enviados: [] };

export function useFriends(token, socket) {
  const [amigos, setAmigos] = useState([]);
  const [pedidos, setPedidos] = useState(EMPTY_REQUESTS);
  const [carregando, setCarregando] = useState(Boolean(token));
  const [erro, setErro] = useState('');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    if (!token) { setAmigos([]); setPedidos(EMPTY_REQUESTS); setErro(''); setCarregando(false); return; }
    setCarregando(true);
    try {
      const [friends, pending] = await Promise.all([
        apiFetch('/api/amigos', token),
        apiFetch('/api/amigos/pedidos', token),
      ]);
      if (!Array.isArray(friends) || !Array.isArray(pending.recebidos) || !Array.isArray(pending.enviados)) {
        throw new Error('Não foi possível ler sua lista de amigos.');
      }
      if (sequence !== request.current) return;
      setAmigos(friends); setPedidos(pending); setErro('');
    } catch (error) {
      if (sequence === request.current) setErro(error.message || 'Não foi possível carregar seus amigos.');
    } finally {
      if (sequence === request.current) setCarregando(false);
    }
  }, [token]);

  useEffect(() => {
    setAmigos([]); setPedidos(EMPTY_REQUESTS);
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!socket || !token) return;
    const online = ({ usuarioId }) => setAmigos(list => list.map(friend => String(friend.id) === String(usuarioId) ? { ...friend, online: true } : friend));
    const offline = ({ usuarioId }) => setAmigos(list => list.map(friend => String(friend.id) === String(usuarioId) ? { ...friend, online: false } : friend));
    socket.on('amizades-atualizadas', refresh); socket.on('connect', refresh);
    socket.on('amigo-online', online); socket.on('amigo-offline', offline);
    return () => {
      socket.off('amizades-atualizadas', refresh); socket.off('connect', refresh);
      socket.off('amigo-online', online); socket.off('amigo-offline', offline);
    };
  }, [socket, token, refresh]);

  async function mutate(path, method, body) {
    const result = await apiFetch(path, token, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    await refresh();
    return result;
  }

  return {
    amigos, pedidos, carregando, erro, refresh,
    adicionar: nome => mutate('/api/amigos/pedidos', 'POST', { nome }),
    aceitar: id => mutate(`/api/amigos/pedidos/${id}/aceitar`, 'POST'),
    recusar: id => mutate(`/api/amigos/pedidos/${id}`, 'DELETE'),
    remover: id => mutate(`/api/amigos/${id}`, 'DELETE'),
  };
}
