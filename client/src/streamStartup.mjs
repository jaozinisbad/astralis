const INITIAL_BITRATE_LIMIT = 8_000_000;
const REPAIR_CODECS = /^(?:rtx|red|ulpfec|flexfec-03)$/i;

export function withScreenStartBitrate(answer, mid, maxBitrate) {
  const sdp = answer?.sdp;
  if (answer?.type !== 'answer' || typeof sdp !== 'string' || mid == null
    || !Number.isFinite(maxBitrate) || maxBitrate < 1000) return answer;

  // Give Chromium a starting estimate within the sender's budget. Its
  // congestion controller remains free to lower or raise the actual rate.
  const startKbps = Math.floor(Math.min(maxBitrate, INITIAL_BITRATE_LIMIT) / 1000);
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n';
  const sections = sdp.split(/(?=^m=)/m);
  const index = sections.findIndex((section) => section.startsWith('m=video ')
    && section.split(newline).includes(`a=mid:${mid}`));
  if (index < 0 || /^m=video 0 /m.test(sections[index])) return answer;

  const lines = sections[index].split(newline);
  if (lines.includes('a=inactive') || lines.includes('a=sendonly')) return answer;
  const fmtpPayloads = new Set(lines.flatMap((line) => {
    const match = /^a=fmtp:(\d+) /.exec(line);
    return match ? [match[1]] : [];
  }));
  const videoPayloads = new Set(lines.flatMap((line) => {
    const match = /^a=rtpmap:(\d+) ([^/]+)\/\d+/.exec(line);
    return match && !REPAIR_CODECS.test(match[2]) ? [match[1]] : [];
  }));
  const parameter = `x-google-start-bitrate=${startKbps}`;
  sections[index] = lines.flatMap((line) => {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && videoPayloads.has(fmtp[1])) {
      const parameters = fmtp[2].split(';')
        .filter((value) => !/^x-google-start-bitrate\s*=/i.test(value.trim()));
      return [`a=fmtp:${fmtp[1]} ${[...parameters, parameter].join(';')}`];
    }
    const payload = /^a=rtpmap:(\d+) /.exec(line)?.[1];
    return videoPayloads.has(payload) && !fmtpPayloads.has(payload)
      ? [line, `a=fmtp:${payload} ${parameter}`]
      : [line];
  }).join(newline);
  const adjusted = sections.join('');
  return adjusted === sdp ? answer : { type: answer.type, sdp: adjusted };
}
