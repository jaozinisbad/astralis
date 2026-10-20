import { useEffect, useRef, useState } from 'react';

const END_MESSAGES = {
  declined: 'A chamada foi recusada.',
  cancelled: 'A chamada foi cancelada.',
  timeout: 'A chamada não foi atendida.',
  disconnected: 'A chamada terminou porque a conexão foi interrompida.',
  'friendship-removed': 'A chamada terminou porque a amizade foi removida.',
  'answered-elsewhere': 'A chamada foi atendida em outro dispositivo.',
};

export function requestDirectCall(socket, event, data, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) { reject(new Error('Conecte-se ao Astralis para ligar.')); return; }
    const timer = setTimeout(() => reject(new Error('O servidor demorou para confirmar a chamada.')), timeout);
    try {
      socket.emit(event, data, result => {
        clearTimeout(timer);
        if (result?.ok) resolve(result);
        else reject(Object.assign(new Error(result?.error || 'Não foi possível completar a chamada.'), { code: result?.code }));
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

export function useDirectCall({ socket, usuarioId, onActive, onEnded }) {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const current = useRef(null);
  const operation = useRef(0);
  const busy = useRef(false);
  const callbacks = useRef({ onActive, onEnded });
  callbacks.current = { onActive, onEnded };
  const closed = useRef(new Set());
  const mounted = useRef(false);

  function receive(next) {
    if (!mounted.current || !next?.id || closed.current.has(next.id)) return;
    if (current.current && current.current.id !== next.id) return;
    if (current.current?.status === 'active' && next.status !== 'active') return;
    const becameActive = next.status === 'active' && current.current?.status !== 'active';
    current.current = next; setCall(next); setError('');
    if (becameActive) callbacks.current.onActive?.(next);
  }
  function finish(callId, reason) {
    closed.current.add(callId);
    if (closed.current.size > 100) closed.current.delete(closed.current.values().next().value);
    if (current.current?.id !== callId) return;
    current.current = null; setCall(null);
    operation.current++; busy.current = false; setPending(false);
    setError(END_MESSAGES[reason] || '');
    callbacks.current.onEnded?.(callId);
  }

  useEffect(() => {
    mounted.current = true;
    current.current = null; setCall(null); setError(''); setPending(false); busy.current = false;
    if (!socket || !usuarioId) return () => { mounted.current = false; operation.current++; };
    const state = ({ call: next } = {}) => receive(next);
    const ended = ({ callId, reason } = {}) => finish(callId, reason);
    const disconnect = () => { if (current.current) finish(current.current.id, 'disconnected'); operation.current++; busy.current = false; setPending(false); };
    socket.on('chamada:recebida', state); socket.on('chamada:estado', state);
    socket.on('chamada:encerrada', ended); socket.on('disconnect', disconnect);
    return () => {
      mounted.current = false; operation.current++; busy.current = false;
      socket.off('chamada:recebida', state); socket.off('chamada:estado', state);
      socket.off('chamada:encerrada', ended); socket.off('disconnect', disconnect);
      if (current.current) callbacks.current.onEnded?.(current.current.id);
      current.current = null;
    };
  }, [socket, usuarioId]);

  async function act(event, data) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    const sequence = ++operation.current;
    try {
      const result = await requestDirectCall(socket, event, data);
      if (!mounted.current || sequence !== operation.current) return;
      if (result.call) receive(result.call);
      return result;
    } catch (cause) {
      if (mounted.current && sequence === operation.current) setError(cause.message);
    } finally {
      if (mounted.current && sequence === operation.current) { busy.current = false; setPending(false); }
    }
  }
  function end() {
    const active = current.current;
    if (!active) return;
    const event = active.status === 'active' ? 'chamada:encerrar'
      : String(active.caller.id) === String(usuarioId) ? 'chamada:cancelar' : 'chamada:recusar';
    // Stop capture immediately; the server also ends on disconnect.
    finish(active.id, 'ended');
    void requestDirectCall(socket, event, { callId: active.id }).catch(cause => {
      if (mounted.current && !current.current && cause.code !== 'not-found') setError(cause.message);
    });
  }
  return {
    call, error, pending,
    incoming: Boolean(call && String(call.callee.id) === String(usuarioId)),
    clearError: () => setError(''),
    reportError: setError,
    start: friend => current.current ? undefined : act('chamada:iniciar', { paraUsuarioId: friend.id }),
    accept: () => current.current && act('chamada:aceitar', { callId: current.current.id }),
    end,
  };
}
