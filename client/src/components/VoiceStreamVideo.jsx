import React, { useEffect, useRef } from 'react';

export default function VoiceStreamVideo({ stream, onResize }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => { video.srcObject = null; };
  }, [stream]);
  return <video ref={videoRef} autoPlay playsInline muted onResize={onResize} />;
}
