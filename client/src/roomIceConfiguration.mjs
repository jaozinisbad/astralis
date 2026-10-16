export const DEFAULT_ROOM_ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);

const configurationBySocket = new WeakMap();

export function loadRoomIceConfiguration(socket, roomId) {
  // Older socket adapters and test transports can continue using direct ICE.
  if (typeof socket.timeout !== 'function') return Promise.resolve(DEFAULT_ROOM_ICE_SERVERS);
  const cached = configurationBySocket.get(socket);
  if (cached && cached.socketId === socket.id && cached.expiresAt > Date.now()) return cached.promise;

  const entry = { socketId: socket.id, expiresAt: Infinity, promise: null };
  entry.promise = new Promise((resolve) => {
    const fallback = () => {
      entry.expiresAt = 0;
      resolve(DEFAULT_ROOM_ICE_SERVERS);
    };
    try {
      socket.timeout(3000).emit('sala:ice-config', { roomId }, (error, result) => {
        if (error || result?.ok !== true || !Array.isArray(result.iceServers) || !result.iceServers.length) {
          fallback();
          return;
        }
        entry.expiresAt = Number.isFinite(result.expiresAt)
          ? Math.min(Date.now() + 300_000, result.expiresAt - 60_000)
          : Date.now() + 60_000;
        resolve(result.iceServers);
      });
    } catch {
      fallback();
    }
  });
  configurationBySocket.set(socket, entry);
  return entry.promise;
}
