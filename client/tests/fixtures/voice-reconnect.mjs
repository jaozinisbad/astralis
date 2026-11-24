import React from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import VoiceChannel from '../../src/components/VoiceChannel.jsx';
import { useDirectCall } from '../../src/useDirectCall.mjs';

const user = Number(location.hash.slice(1));
const socket = io({ transports: ['websocket'], auth: { user }, reconnectionDelay: 1800,
  reconnectionDelayMax: 1800, randomizationFactor: 0 });
const sound = new AudioContext();
const tone = sound.createOscillator();
tone.frequency.value = user === 1 ? 440 : 880;
const mic = sound.createMediaStreamDestination();
tone.connect(mic);
tone.start();
navigator.mediaDevices.getUserMedia = async () => mic.stream;
localStorage.setItem('configuracoesAudio', JSON.stringify({ perfilEntrada: 'estudio', supressaoRuido: 'desligada' }));

// Observe the remote track attached to each playback element. Silence the
// test windows separately so this never plays the tones on physical speakers.
const elements = [];
const NativeAudio = window.Audio;
window.Audio = function(...args) {
  const audio = new NativeAudio(...args);
  elements.push({ audio });
  return audio;
};
window.Audio.prototype = NativeAudio.prototype;
const silent = sound.createGain();
silent.gain.value = 0;
silent.connect(sound.destination);
const NativePeer = window.RTCPeerConnection;
window.RTCPeerConnection = class extends NativePeer {
  constructor(config) { super({ ...config, iceServers: [] }); }
  setConfiguration(config) { super.setConfiguration({ ...config, iceServers: [] }); }
};

function Participant() {
  const call = useDirectCall({ socket, usuarioId: user });
  window.probe = {
    start: () => call.start({ id: 2 }), accept: () => call.accept(), end: call.end,
    connected: socket.connected, callId: call.call?.id, phase: call.call?.status, error: call.error,
    measure() {
      const entry = elements.find(({ audio }) => audio.srcObject && !audio.muted && !audio.paused);
      if (!entry) return 0;
      if (entry.stream !== entry.audio.srcObject) {
        entry.source?.disconnect();
        entry.stream = entry.audio.srcObject;
        entry.source = sound.createMediaStreamSource(entry.stream);
        entry.analyser = sound.createAnalyser();
        entry.source.connect(entry.analyser).connect(silent);
      }
      const samples = new Float32Array(entry.analyser.fftSize);
      entry.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
    }
  };
  return call.call?.status === 'active' ? React.createElement(VoiceChannel, {
    canal: { id: call.call.canalId, direta: true, nome: 'Chamada local' }, socket, visible: true, nomeUsuario: String(user)
  }) : null;
}
sound.resume();
createRoot(document.getElementById('root')).render(React.createElement(Participant));