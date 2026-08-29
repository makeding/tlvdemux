const AUDIO_LAYOUTS = [
  '不明', 'モノラル', 'デュアルモノ', 'ステレオ', '2.1ch', '3.0ch', '2.2ch',
  '4.0ch', '5.0ch', '5.1ch', '3.3.1ch', '6.1ch', '7.1ch', '10.2ch', '22.2ch',
];

export const MSE_MAX_AUDIO_CHANNELS = 6;

export function createDemoTrackControls({
  elements, selectionLevel, audioTrackChoices, state,
}) {
  const mseAudioTrackSupported = track => {
    const channels = track.audio?.channels ?? 0;
    return channels === 0 || channels <= MSE_MAX_AUDIO_CHANNELS;
  };

  const videoTrackLabel = track => {
    const level = selectionLevel(track);
    const layer = level === 0 ? '通常' : level === 1 ? '降雨対応' : `level=${level ?? '—'}`;
    return `${layer} · 0x${track.packetId.toString(16)}`;
  };

  const renderVideoTracks = () => {
    const {knownVideoTracks, videoSelectionMode, selectedVideoPacketId} = state();
    elements.videoTrack.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '自動';
    elements.videoTrack.append(automatic);
    const sorted = [...knownVideoTracks.values()].sort((left, right) =>
      (selectionLevel(left) ?? 0xff) - (selectionLevel(right) ?? 0xff) ||
      left.packetId - right.packetId);
    for (const track of sorted) {
      const option = document.createElement('option');
      option.value = String(track.packetId);
      option.textContent = videoTrackLabel(track);
      elements.videoTrack.append(option);
    }
    elements.videoTrack.value = videoSelectionMode === 'fixed' &&
      selectedVideoPacketId !== null && knownVideoTracks.has(selectedVideoPacketId)
      ? String(selectedVideoPacketId) : '';
    elements.videoTrack.disabled = knownVideoTracks.size < 2;
  };

  const preferredMseAudioTrack = (tracks, preferredPacketId = null) => {
    const compatible = [...tracks.values()].filter(mseAudioTrackSupported);
    if (preferredPacketId !== null) {
      const preferred = compatible.find(track => track.packetId === preferredPacketId);
      if (preferred) return preferred;
    }
    return compatible.find(track => track.audio?.mainComponent) || compatible[0];
  };

  const audioTrackLabel = track => {
    const parts = [`0x${track.packetId.toString(16)}`];
    if (track.language) parts.push(track.language);
    if (track.audio) {
      parts.push(AUDIO_LAYOUTS[track.audio.channelLayout] || `${track.audio.channelLayout}ch`);
      if (track.audio.sampleRate) parts.push(`${track.audio.sampleRate}Hz`);
      if (track.audio.mainComponent) parts.push('メイン');
      if (track.audio.multilingual) parts.push('二か国語');
    }
    if (!mseAudioTrackSupported(track)) parts.push('MSE 非対応');
    return parts.join(' · ');
  };

  const audioChoiceValue = choice => choice.groupIdentification === null
    ? `track:${choice.track.packetId}` : `group:${choice.groupIdentification}`;

  const renderAudioTracks = () => {
    const {
      knownAudioTracks, selectedAudioGroupId, preferredAudioPacketId, selectedAudioPacketId,
    } = state();
    elements.audioTrack.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '自動';
    elements.audioTrack.append(automatic);
    const choices = audioTrackChoices(knownAudioTracks.values(), mseAudioTrackSupported);
    for (const choice of choices) {
      const {track, groupIdentification} = choice;
      const option = document.createElement('option');
      option.value = audioChoiceValue(choice);
      option.textContent = groupIdentification === null
        ? audioTrackLabel(track)
        : `${audioTrackLabel(track)} · group=0x${groupIdentification.toString(16)}`;
      option.disabled = !mseAudioTrackSupported(track);
      elements.audioTrack.append(option);
    }
    let desiredGroup = selectedAudioGroupId;
    if (desiredGroup === null && preferredAudioPacketId !== null) {
      desiredGroup = knownAudioTracks.get(preferredAudioPacketId)?.assetGroups?.[0]
        ?.groupIdentification ?? null;
    }
    const desiredChoice = desiredGroup !== null
      ? choices.find(choice => choice.groupIdentification === desiredGroup)
      : choices.find(choice => choice.track.packetId ===
          (selectedAudioPacketId ?? preferredAudioPacketId));
    elements.audioTrack.value = desiredChoice ? audioChoiceValue(desiredChoice) : '';
    elements.audioTrack.disabled = choices.length === 0;
  };

  const renderSubtitleTracks = () => {
    const {knownSubtitleTracks, preferredSubtitlePacketId, selectedSubtitlePacketId} = state();
    elements.subtitleTrack.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '自動';
    elements.subtitleTrack.append(automatic);
    for (const track of [...knownSubtitleTracks.values()].sort((a, b) => a.packetId - b.packetId)) {
      const option = document.createElement('option');
      option.value = String(track.packetId);
      const parts = [`字幕 · 0x${track.packetId.toString(16)}`];
      if (track.language) parts.push(track.language);
      if (track.subtitle) {
        parts.push(`mode=${track.subtitle.operationMode}`);
        parts.push(`timing=${track.subtitle.timingMode}`);
        parts.push(`display=${track.subtitle.displayMode}`);
      }
      option.textContent = parts.join(' · ');
      elements.subtitleTrack.append(option);
    }
    const desired = preferredSubtitlePacketId ?? selectedSubtitlePacketId;
    elements.subtitleTrack.value = desired !== null && knownSubtitleTracks.has(desired)
      ? String(desired) : '';
    elements.subtitleTrack.disabled = knownSubtitleTracks.size === 0;
  };

  return {
    mseAudioTrackSupported, videoTrackLabel, renderVideoTracks,
    preferredMseAudioTrack, audioChoiceValue, renderAudioTracks, renderSubtitleTracks,
  };
}
