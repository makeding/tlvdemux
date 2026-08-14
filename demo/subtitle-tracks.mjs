export function subtitleTrackKind(track) {
  if (track?.subtitle?.type === 0) return 'caption';
  if (track?.subtitle?.type === 1) return 'superimpose';
  const packetId = Number.isInteger(track?.packetId)
    ? `0x${track.packetId.toString(16)}` : 'unknown';
  throw new Error(`TTML packet_id=${packetId} has invalid subtitle.type`);
}

export function preferredCaptionTrack(tracks, preferredPacketId = null) {
  const captions = [...tracks].filter(track => subtitleTrackKind(track) === 'caption');
  if (preferredPacketId !== null) {
    const preferred = captions.find(track => track.packetId === preferredPacketId);
    if (preferred) return preferred;
  }
  return captions[0];
}

export function shouldRenderSubtitleTrack(track, selectedCaptionTrackId) {
  const kind = subtitleTrackKind(track);
  return kind === 'superimpose' || track.trackId === selectedCaptionTrackId;
}
