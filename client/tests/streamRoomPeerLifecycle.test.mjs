import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamRoomPeerSession } from '../src/streamRoomPeer.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

class RoomSocket {
  id = 'presenter';
  listeners = new Map();
  sent = [];
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
  }
  off(event, listener) { this.listeners.get(event)?.delete(listener); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  receive(event, payload) { this.listeners.get(event)?.forEach((listener) => listener(payload)); }
}

for (const delayedOperation of ['createOffer', 'setLocalDescription']) {
  test(`stream peer lifecycle: a cancelled ${delayedOperation} cannot tear down the replacement connection`, async (t) => {
    const peers = [];
    let rejectCancelledOperation;
    class Peer {
      connectionState = 'new';
      signalingState = 'stable';
      senders = [];
      constructor() { peers.push(this); }
      addTrack(track) {
        const sender = {
          track,
          getParameters: () => ({ encodings: [{}] }),
          setParameters: async () => {},
        };
        this.senders.push(sender);
      }
      getSenders() { return this.senders; }
      async createOffer() {
        if (peers[0] === this && delayedOperation === 'createOffer') {
          await new Promise((_resolve, reject) => { rejectCancelledOperation = reject; });
        }
        return { type: 'offer', sdp: 'replacement-offer' };
      }
      async setLocalDescription(description) {
        if (peers[0] === this && delayedOperation === 'setLocalDescription') {
          await new Promise((_resolve, reject) => { rejectCancelledOperation = reject; });
        }
        this.localDescription = description;
        this.signalingState = 'have-local-offer';
      }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.signalingState = 'stable';
      }
      close() { this.connectionState = 'closed'; this.signalingState = 'closed'; }
    }
    const socket = new RoomSocket();
    const session = createStreamRoomPeerSession({
      socket, roomId: 'room', role: 'host', streamId: socket.id,
      RTCPeerConnectionImpl: Peer,
      setTimeoutImpl: () => null, clearTimeoutImpl: () => {},
      setIntervalImpl: () => null, clearIntervalImpl: () => {},
    });
    t.after(() => session.close());
    const track = { kind: 'video' };
    session.setLocalStream({ getTracks: () => [track] });
    socket.receive('sala:espectador-entrou', { salaId: 'room', socketId: 'viewer' });
    await flush();
    assert.equal(typeof rejectCancelledOperation, 'function');

    socket.receive('sala:espectador-entrou', {
      salaId: 'room', socketId: 'viewer', streamId: socket.id, restart: true,
    });
    await flush();
    assert.equal(peers.length, 2);
    assert.equal(session.getPeerCount(), 1);
    assert.equal(peers[1].signalingState, 'have-local-offer');

    rejectCancelledOperation(new DOMException('The peer connection was closed.', 'InvalidStateError'));
    await flush();
    assert.equal(session.getPeerCount(), 1, 'a late rejection from the old peer must leave its successor alive');
    assert.notEqual(peers[1].connectionState, 'closed');

    const offer = socket.sent.find(({ event }) => event === 'sala:sinal:oferta');
    socket.receive('sala:sinal:resposta', {
      roomId: 'room', streamId: socket.id, de: 'viewer',
      resposta: { type: 'answer', sdp: 'replacement-answer', negotiationId: offer.payload.descricao.negotiationId },
    });
    await flush();
    assert.equal(peers[1].remoteDescription?.sdp, 'replacement-answer');
  });
}
