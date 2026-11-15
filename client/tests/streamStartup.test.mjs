import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withScreenStartBitrate } from '../src/streamStartup.mjs';

const audio = [
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
];
const video = [
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
  'a=mid:2',
  'a=recvonly',
  'a=fmtp:98 packetization-mode=1;x-google-start-bitrate=300',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
];
const sdpOf = (...sections) => ['v=0', ...sections.flat(), ''].join('\r\n');

test('startup hint is limited to the screen section and capped by the per-viewer budget', () => {
  const otherVideo = video.map((line) => line.replace('a=mid:2', 'a=mid:1'));
  const answer = { type: 'answer', sdp: sdpOf(audio, video, otherVideo) };
  const adjusted = withScreenStartBitrate(answer, '2', 4_000_750);
  assert.equal(adjusted.sdp, sdpOf(audio, [
    ...video.slice(0, 3),
    'a=fmtp:98 packetization-mode=1;x-google-start-bitrate=4000',
    video[4], 'a=fmtp:96 x-google-start-bitrate=4000', ...video.slice(5),
  ], otherVideo));
  assert.equal(withScreenStartBitrate(adjusted, '2', 4_000_750), adjusted);
  assert.match(withScreenStartBitrate(answer, '2', 16_000_000).sdp, /x-google-start-bitrate=8000/);
});

test('startup hint leaves inactive, rejected and unrelated sections alone', () => {
  for (const section of [
    video.map((line) => line.replace('a=recvonly', 'a=inactive')),
    video.map((line) => line.replace('a=recvonly', 'a=sendonly')),
    video.map((line) => line.replace('m=video 9', 'm=video 0')),
    audio,
  ]) {
    const answer = { type: 'answer', sdp: sdpOf(section) };
    assert.equal(withScreenStartBitrate(answer, '2', 16_000_000), answer);
  }
});
