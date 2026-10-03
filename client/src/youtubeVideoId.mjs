const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

export function isYouTubeVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

export function parseYouTubeVideoId(value) {
  if (typeof value !== 'string') return null;

  const input = value.trim();
  if (!input || input.length > 2048) return null;

  // Allow users to paste a bare YouTube host/path, but never infer a host for
  // arbitrary text or protocol-relative URLs.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
  const withoutScheme = input.replace(/^https:\/\//i, '');
  const bareYouTubeUrl = /^(?:(?:www|m)\.)?youtube\.com(?:\/|$)|^(?:www\.)?youtu\.be(?:\/|$)/i.test(withoutScheme);

  let url;
  try {
    url = new URL(hasScheme ? input : bareYouTubeUrl ? `https://${input}` : input);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    !YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }

  let videoId = null;
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const match = url.pathname.match(/^\/([^/]+)\/?$/);
    videoId = match?.[1] ?? null;
  } else if (url.pathname === '/watch') {
    const videoIds = url.searchParams.getAll('v');
    if (videoIds.length !== 1) return null;
    videoId = videoIds[0];
  } else {
    const match = url.pathname.match(/^\/shorts\/([^/]+)\/?$/);
    videoId = match?.[1] ?? null;
  }

  return isYouTubeVideoId(videoId) ? videoId : null;
}
