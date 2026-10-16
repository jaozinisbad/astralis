const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
const { createRoomIceConfiguration } = require('../iceConfig');

test('room ICE: missing or invalid TURN settings preserve direct STUN without exposing a secret', () => {
  for (const env of [{}, { WEBRTC_TURN_URLS: 'turn:example.com:3478' }, { WEBRTC_TURN_URLS: 'https://invalid.example', WEBRTC_TURN_SECRET: 'private-secret' }]) {
    const config = createRoomIceConfiguration({ env, socketId: 'viewer-a', now: 1_000_000 });
    assert.deepEqual(config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
    assert.equal(JSON.stringify(config).includes('private-secret'), false);
  }
});

test('room ICE: configured TURN delivers expiring socket credentials while keeping the shared secret on the server', () => {
  const env = { WEBRTC_TURN_URLS: 'turn:relay.example:3478?transport=udp,turns:relay.example:443?transport=tcp', WEBRTC_TURN_SECRET: 'local-test-secret' };
  const config = createRoomIceConfiguration({ env, socketId: 'viewer-a', now: 1_000_000 });
  const turn = config.iceServers[1];
  assert.deepEqual(turn.urls, ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443?transport=tcp']);
  assert.equal(turn.username, '4600:viewer-a');
  assert.equal(config.expiresAt, 4_600_000);
  assert.equal(turn.credential, createHmac('sha1', env.WEBRTC_TURN_SECRET).update(turn.username).digest('base64'));
  assert.equal(JSON.stringify(config).includes(env.WEBRTC_TURN_SECRET), false);
  const later = createRoomIceConfiguration({ env, socketId: 'viewer-b', now: 1_001_000 });
  assert.notEqual(later.iceServers[1].credential, turn.credential);
});
