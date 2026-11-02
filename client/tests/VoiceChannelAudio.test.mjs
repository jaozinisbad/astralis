import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createServer } from 'vite';

let vite, VoiceChannel;
before(async () => {
  vite = await createServer({
    configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { optimizeDeps: { noDiscovery: true, include: [] } }, appType: 'custom',
  });
  ({ default: VoiceChannel } = await vite.ssrLoadModule('/src/components/VoiceChannel.jsx'));
});
after(async () => vite?.close());

function track(kind, id) {
  return { kind, id, enabled: true, getSettings: () => ({ height: 1080 }), stop() { this.stopped = true; } };
}
function stream(...tracks) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
    addTrack(item) { tracks.push(item); },
  };
}

async function withCall(direct, run) {
  const keys = ['window', 'navigator', 'document', 'localStorage', 'Audio', 'RTCPeerConnection'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const microphones = [], audios = [], peers = [], participants = [];
  class AudioContext {
    currentTime = 0;
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
    createMediaStreamDestination() { return { stream: stream(track('audio', 'processed-mic')) }; }
    async close() {}
  }
  class Audio {
    constructor() { audios.push(this); }
    pause() {}
    async setSinkId(id) { this.sinkId = id; }
  }
  class Peer {
    constructor() { this.senders = []; peers.push(this); }
    addTrack(mediaTrack, mediaStream) {
      const sender = {
        track: mediaTrack, stream: mediaStream, getParameters: () => ({}),
        setParameters: async () => {}, replaceTrack: async (next) => { sender.track = next; },
      };
      this.senders.push(sender);
      return sender;
    }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const values = {
    window: { AudioContext }, document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => JSON.stringify({ perfilEntrada: 'estudio', supressaoRuido: 'desligada' }) },
    navigator: { mediaDevices: { getUserMedia: async () => {
      const mic = stream(track('audio', `raw-mic-${microphones.length}`));
      microphones.push(mic);
      return mic;
    } } }, Audio, RTCPeerConnection: Peer,
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    for (const [id, remoteId] of [['a', 'b'], ['b', 'a']]) {
      const listeners = new Map(), states = [], assignments = [];
      let attachedStream;
      const videoNode = {
        get srcObject() { return attachedStream; },
        set srcObject(value) { attachedStream = value; assignments.push(value); },
      };
      const socket = { id, on: (event, fn) => listeners.set(event, fn), off: (event) => listeners.delete(event), emit() {} };
      const ref = React.createRef();
      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(VoiceChannel, {
          ref, canal: { id: direct ? 'direta:call-1' : 'voice:1', nome: 'Chamada', direta: direct },
          socket, visible: true, nomeUsuario: id.toUpperCase(), onEstadoChange: (value) => states.push(value),
        }), { createNodeMock: ({ type }) => type === 'video' ? videoNode : null });
      });
      const participant = { ref, renderer, listeners, assignments, state: () => states.at(-1), mic: microphones.at(-1) };
      participants.push(participant);
      await act(async () => listeners.get('peers-existentes')({ peers: [{ socketId: remoteId, nome: remoteId.toUpperCase() }] }));
      participant.peer = peers.at(-1);
    }
    await run({ participants, audios, peers, microphones });
  } finally {
    for (const participant of participants) await act(async () => participant.renderer.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

async function setControls(participant, muted, deafened) {
  if (participant.state().micMudo !== muted) await act(async () => participant.ref.current.alternarMudo());
  if (participant.state().audioMudo !== deafened) await act(async () => participant.ref.current.alternarAudio());
}

for (const direct of [false, true]) test(`${direct ? 'private call' : 'voice channel'}: all 16 local/remote mute and deafen combinations keep stream audio independent`, async () => {
  await withCall(direct, async ({ participants: [a, b], audios, peers, microphones }) => {
    // Begin sharing while both sides have already muted/deafened voice.
    await setControls(a, true, true);
    await setControls(b, true, true);
    const captured = stream(track('video', 'screen-video'), track('audio', 'game-audio'));
    await act(async () => a.ref.current.iniciarCompartilhamento({ stream: captured }));
    const microphoneSent = a.peer.getSenders().find((sender) => !captured.getTracks().includes(sender.track));
    await act(async () => {
      b.peer.ontrack({ track: microphoneSent.track, streams: [microphoneSent.stream] });
      b.peer.ontrack({ track: captured.getVideoTracks()[0], streams: [captured] });
      b.peer.ontrack({ track: captured.getAudioTracks()[0], streams: [captured] });
    });
    await act(async () => b.ref.current.alternarTransmissao('a'));
    const voice = audios.find((audio) => audio.srcObject === microphoneSent.stream);
    const game = audios.find((audio) => audio.srcObject === captured);
    const originalAssignments = [...b.assignments];
    assert.equal(voice.muted, true);
    assert.equal(game.muted, false, 'opening a stream must play its own audio even while voice is deafened');

    for (let mask = 0; mask < 16; mask += 1) {
      const [aMuted, aDeafened, bMuted, bDeafened] = [1, 2, 4, 8].map((bit) => Boolean(mask & bit));
      await setControls(a, aMuted, aDeafened);
      await setControls(b, bMuted, bDeafened);
      assert.equal(a.mic.getAudioTracks()[0].enabled, !aMuted, `sender microphone at mask ${mask}`);
      assert.equal(b.mic.getAudioTracks()[0].enabled, !bMuted, `receiver microphone at mask ${mask}`);
      assert.equal(voice.muted, bDeafened, `received voice at mask ${mask}`);
      assert.equal(game.muted, false, `received game audio at mask ${mask}`);
      for (const mediaTrack of captured.getTracks()) {
        assert.equal(mediaTrack.enabled, true, `capture remains enabled at mask ${mask}`);
        assert.notEqual(mediaTrack.stopped, true);
        assert.ok(a.peer.getSenders().some((sender) => sender.track === mediaTrack));
      }
    }
    assert.deepEqual(b.assignments, originalAssignments, 'voice toggles must not reattach the playing video');

    // An arriving peer receives the still-enabled capture while the sender is deafened.
    await act(async () => a.listeners.get('webrtc-oferta')({ de: 'late-peer', oferta: { type: 'offer', sdp: 'late' } }));
    for (const mediaTrack of captured.getTracks()) assert.ok(peers.at(-1).getSenders().some((sender) => sender.track === mediaTrack && sender.track.enabled));

    // Rebuilding a muted microphone must replace only its sender, preserving screen senders.
    const previousMicrophone = microphoneSent.track;
    await act(async () => a.ref.current.aplicarConfiguracao({ microfoneId: 'replacement-mic' }));
    assert.equal(microphones.at(-1).getAudioTracks()[0].enabled, false);
    assert.equal(a.mic.getAudioTracks()[0].stopped, true);
    assert.notEqual(microphoneSent.track, previousMicrophone);
    assert.equal(a.state().micMudo, true);
    assert.equal(a.state().audioMudo, true);
    for (const mediaTrack of captured.getTracks()) assert.ok(a.peer.getSenders().some((sender) => sender.track === mediaTrack && sender.track.enabled));

    const volume = b.renderer.root.findByProps({ 'aria-label': 'Volume da transmissão de A' });
    await act(async () => volume.props.onChange({ target: { valueAsNumber: 35 } }));
    assert.equal(game.volume, 0.35);
    await act(async () => b.renderer.root.findByProps({ 'aria-label': 'Mutar o áudio dessa tela' }).props.onClick());
    assert.equal(game.muted, true);
    await setControls(b, false, false);
    await setControls(b, true, true);
    assert.equal(game.muted, true, 'voice toggles preserve the stream mute');
    assert.equal(game.volume, 0.35);
    await act(async () => b.renderer.root.findByProps({ 'aria-label': 'Ativar o áudio dessa tela' }).props.onClick());
    assert.equal(game.muted, false);
    await act(async () => b.ref.current.fecharTransmissao());
    assert.equal(game.muted, true, 'closing the selected stream still stops its audio');
    await act(async () => b.ref.current.alternarTransmissao('a'));
    assert.equal(game.muted, false);
    assert.equal(game.volume, 0.35);
    await act(async () => b.ref.current.aplicarConfiguracao({ volumeSaida: 80, foneId: 'headset' }));
    assert.equal(game.volume, 0.28, 'the output volume still combines with the stream volume');
    assert.equal(voice.volume, 0.8);
    assert.equal(game.sinkId, 'headset');
    assert.equal(voice.sinkId, 'headset');
    assert.equal(game.muted, false);
    assert.equal(voice.muted, true);
  });
});

for (const microphoneFirst of [false, true]) test(`deafened receiver reclassifies early stream audio when video arrives (microphone first: ${microphoneFirst})`, async () => {
  await withCall(false, async ({ participants: [, b], audios }) => {
    await setControls(b, true, true);
    const micTrack = track('audio', 'remote-mic'), mic = stream(micTrack);
    const gameTrack = track('audio', 'game'), earlyScreen = stream(gameTrack);
    await act(async () => {
      if (microphoneFirst) b.peer.ontrack({ track: micTrack, streams: [mic] });
      b.peer.ontrack({ track: gameTrack, streams: [earlyScreen] });
      if (!microphoneFirst) b.peer.ontrack({ track: micTrack, streams: [mic] });
      const video = track('video', 'late-video');
      earlyScreen.addTrack(video);
      b.peer.ontrack({ track: video, streams: [earlyScreen] });
    });
    await act(async () => b.ref.current.alternarTransmissao('a'));
    const game = audios.find((audio) => audio.srcObject === earlyScreen);
    const voice = audios.find((audio) => audio.srcObject === mic);
    assert.ok(game && voice, 'screen and microphone must retain separate playback elements');
    assert.equal(game.muted, false);
    assert.equal(voice.muted, true);
    await setControls(b, true, false);
    assert.equal(game.muted, false);
    assert.equal(voice.muted, false);
  });
});
