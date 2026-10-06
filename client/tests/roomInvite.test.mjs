import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoomInviteUrl, copyRoomInviteUrl } from '../src/roomInvite.mjs';

test('uses the public site for an invite opened from an Electron file URL', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { currentUrl: 'file:///C:/Astralis/resources/app.asar/dist/index.html?other=value' }),
    'https://astralis-b2w.pages.dev/?room=room-123',
  );
});

test('uses the public site instead of a localhost development URL', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { currentUrl: 'http://localhost:5173/?other=value' }),
    'https://astralis-b2w.pages.dev/?room=room-123',
  );
});

test('uses the configured HTTPS public web origin', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { publicWebUrl: 'https://play.example.com/app?old=value', currentUrl: 'file:///app/index.html' }),
    'https://play.example.com/?room=room-123',
  );
});

test('uses the current production HTTPS origin when no public web URL is configured', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { currentUrl: 'https://play.example.com/sala?old=value' }),
    'https://play.example.com/?room=room-123',
  );
});

test('ignores an insecure public web URL', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { publicWebUrl: 'http://play.example.com', currentUrl: 'file:///app/index.html' }),
    'https://astralis-b2w.pages.dev/?room=room-123',
  );
});

test('encodes the room ID as a single query parameter', () => {
  assert.equal(
    buildRoomInviteUrl('room&code=secret', { currentUrl: 'file:///app/index.html' }),
    'https://astralis-b2w.pages.dev/?room=room%26code%3Dsecret',
  );
});

test('includes the private room access code after the room ID', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { accessCode: 'ABCD2345', currentUrl: 'file:///app/index.html' }),
    'https://astralis-b2w.pages.dev/?room=room-123&code=ABCD2345',
  );
});

test('omits the access code for a public room', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { accessCode: '', currentUrl: 'file:///app/index.html' }),
    'https://astralis-b2w.pages.dev/?room=room-123',
  );
});

test('encodes a private access code as one query parameter', () => {
  assert.equal(
    buildRoomInviteUrl('room-123', { accessCode: 'A&B+12', currentUrl: 'file:///app/index.html' }),
    'https://astralis-b2w.pages.dev/?room=room-123&code=A%26B%2B12',
  );
});

test('rejects missing and blank room IDs', () => {
  for (const roomId of [undefined, null, '', '   ', 123, 'room name']) {
    assert.throws(() => buildRoomInviteUrl(roomId), TypeError);
  }
});

test('copies an invite through the existing Electron bridge', async () => {
  let copied;
  const url = await copyRoomInviteUrl('room-123', {
    currentUrl: 'file:///app/index.html',
    electronAPI: { copiarTexto: async (text) => { copied = text; } },
  });
  assert.equal(url, 'https://astralis-b2w.pages.dev/?room=room-123');
  assert.equal(copied, url);
});

test('copies the private room access code through the Electron bridge', async () => {
  let copied;
  await copyRoomInviteUrl('room-123', {
    accessCode: 'ABCD2345',
    electronAPI: { copiarTexto: async (text) => { copied = text; } },
  });
  assert.equal(copied, 'https://astralis-b2w.pages.dev/?room=room-123&code=ABCD2345');
});

test('copies in a browser when the Electron bridge is unavailable', async () => {
  let copied;
  const url = await copyRoomInviteUrl('room-123', {
    electronAPI: null,
    clipboard: { writeText: async (text) => { copied = text; } },
  });
  assert.equal(copied, url);
});

test('reports unavailable clipboard access', async () => {
  await assert.rejects(
    copyRoomInviteUrl('room-123', { electronAPI: null, clipboard: null }),
    /clipboard/i,
  );
});
