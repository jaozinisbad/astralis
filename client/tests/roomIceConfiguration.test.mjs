import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ROOM_ICE_SERVERS, loadRoomIceConfiguration } from '../src/roomIceConfiguration.mjs';

test('room ICE: simultaneous streams share a configuration request, then socket reconnect refreshes it', async () => {
  const requests = [];
  const socket = { id: 'viewer-a', timeout: (delay) => ({ emit: (event, payload, callback) => requests.push({ delay, event, payload, callback }) }) };
  const first = loadRoomIceConfiguration(socket, 'room-1');
  const second = loadRoomIceConfiguration(socket, 'room-1');
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].event, 'sala:ice-config');
  assert.equal(requests[0].delay, 3000);
  const servers = [{ urls: 'turns:relay.example:443?transport=tcp', username: 'temporary-user', credential: 'temporary-password' }];
  requests[0].callback(null, { ok: true, iceServers: servers, expiresAt: Date.now() + 3600_000 });
  assert.deepEqual(await first, servers);
  assert.deepEqual(await loadRoomIceConfiguration(socket, 'room-1'), servers);
  assert.equal(requests.length, 1);
  socket.id = 'viewer-reconnected';
  const refreshed = loadRoomIceConfiguration(socket, 'room-1');
  assert.equal(requests.length, 2);
  requests[1].callback(null, { ok: true, iceServers: servers });
  await refreshed;
});

test('room ICE: older servers and failed authorization fall back to STUN and can retry', async () => {
  const callbacks = [];
  const socket = { id: 'viewer-a', timeout: () => ({ emit: (_event, _payload, callback) => callbacks.push(callback) }) };
  const denied = loadRoomIceConfiguration(socket, 'room-1');
  callbacks[0](null, { ok: false });
  assert.deepEqual(await denied, DEFAULT_ROOM_ICE_SERVERS);
  const retried = loadRoomIceConfiguration(socket, 'room-1');
  callbacks[1](new Error('legacy server timeout'));
  assert.deepEqual(await retried, DEFAULT_ROOM_ICE_SERVERS);
  assert.deepEqual(await loadRoomIceConfiguration({}, 'room-1'), DEFAULT_ROOM_ICE_SERVERS);
});
