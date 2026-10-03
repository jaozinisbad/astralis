import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isYouTubeVideoId, parseYouTubeVideoId } from './youtubeVideoId.mjs';

test('extracts one video ID from supported YouTube URL forms', () => {
  const supported = [
    ['https://youtube.com/watch?v=M7lc1UVf-VE', 'M7lc1UVf-VE'],
    ['www.youtube.com/watch?v=M7lc1UVf-VE&t=30s', 'M7lc1UVf-VE'],
    ['https://m.youtube.com/watch?v=M7lc1UVf-VE', 'M7lc1UVf-VE'],
    ['https://youtu.be/M7lc1UVf-VE?si=share', 'M7lc1UVf-VE'],
    ['https://youtube.com/shorts/M7lc1UVf-VE?feature=share', 'M7lc1UVf-VE'],
    ['youtube.com/watch?v=M7lc1UVf-VE', 'M7lc1UVf-VE'],
  ];

  for (const [url, expectedId] of supported) {
    assert.equal(parseYouTubeVideoId(url), expectedId, url);
  }
});

test('accepts only 11-character YouTube video IDs', () => {
  assert.equal(isYouTubeVideoId('M7lc1UVf-VE'), true);
  assert.equal(isYouTubeVideoId('M7lc1UVf-VE!'), false);
  assert.equal(isYouTubeVideoId('M7lc1UVf-V'), false);
  assert.equal(isYouTubeVideoId(null), false);
});

test('rejects playlist URLs that do not identify a video', () => {
  assert.equal(parseYouTubeVideoId('https://youtube.com/playlist?list=PL1234567890'), null);
  assert.equal(parseYouTubeVideoId('https://youtube.com/watch?list=PL1234567890'), null);
});

test('rejects untrusted hosts, protocols, credentials, and ports', () => {
  const untrusted = [
    'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE',
    'https://evil-youtube.com/watch?v=M7lc1UVf-VE',
    'https://www.youtu.be/M7lc1UVf-VE',
    'https://evil.example/?next=https://youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com@evil.example/watch?v=M7lc1UVf-VE',
    'https://user:pass@youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com:8443/watch?v=M7lc1UVf-VE',
    'http://youtube.com/watch?v=M7lc1UVf-VE',
    'javascript:alert(1)',
  ];

  for (const url of untrusted) {
    assert.equal(parseYouTubeVideoId(url), null, url);
  }
});

test('rejects malformed IDs, duplicate video parameters, and unsupported paths', () => {
  const malformed = [
    'https://youtube.com/watch?v=short',
    'https://youtube.com/watch?v=invalid!id00',
    'https://youtube.com/watch?v=M7lc1UVf-VE&v=abcdefghijk',
    'https://youtu.be/M7lc1UVf-VE/extra',
    'https://youtube.com/shorts/M7lc1UVf-VE/extra',
    'https://youtube.com/embed/M7lc1UVf-VE',
    '',
    null,
    42,
  ];

  for (const url of malformed) {
    assert.equal(parseYouTubeVideoId(url), null, String(url));
  }
});
