function matchingGroup(track, groupIdentification, level = null) {
  return track?.assetGroups?.find(group =>
    (groupIdentification === null || group.groupIdentification === groupIdentification) &&
    (level === null || group.selectionLevel === level)) ?? null;
}

export function selectionLevel(track, groupIdentification = null) {
  const group = matchingGroup(track, groupIdentification);
  if (group) return group.selectionLevel;
  return track?.kind === 'video' && groupIdentification === null &&
    !(track.assetGroups?.length) ? 0 : null;
}

export function shouldReprobeVideoLayerForSeek(track, explicitPacketId) {
  return explicitPacketId === undefined && (selectionLevel(track) ?? 0) > 0;
}

export function automaticLayerSwitchEnabled(explicitPacketId) {
  return explicitPacketId === undefined;
}

export function sameVideoLayerGroup(left, right) {
  if (!left || !right || left.kind !== 'video' || right.kind !== 'video') return false;
  if (left.contextId !== undefined && right.contextId !== undefined &&
      left.contextId !== right.contextId) return false;
  const leftGroups = left.assetGroups || [];
  const rightGroups = right.assetGroups || [];
  if (!leftGroups.length && !rightGroups.length) return false;
  if (!leftGroups.length || !rightGroups.length) return true;
  return leftGroups.some(leftGroup => rightGroups.some(rightGroup =>
    leftGroup.groupIdentification === rightGroup.groupIdentification));
}

export function correspondingAudioTrack(tracks, currentTrack, targetLevel, activeGroupId = null) {
  if (!currentTrack || targetLevel === null) return null;
  const currentGroups = currentTrack.assetGroups || [];
  const groupIds = [];
  if (activeGroupId !== null && currentGroups.some(group =>
    group.groupIdentification === activeGroupId)) groupIds.push(activeGroupId);
  for (const group of currentGroups) {
    if (!groupIds.includes(group.groupIdentification)) groupIds.push(group.groupIdentification);
  }
  for (const groupId of groupIds) {
    const track = [...tracks].find(candidate => candidate.kind === 'audio' &&
      candidate.assetGroups?.some(group => group.groupIdentification === groupId &&
        group.selectionLevel === targetLevel));
    if (track) return {track, groupIdentification: groupId};
  }
  return null;
}

export function audioSelectionIdentity(track, groupIdentification = null) {
  const group = matchingGroup(track, groupIdentification);
  if (!track || !group) return null;
  return {
    contextId: track.contextId,
    componentTag: track.componentTag,
    groupIdentification: group.groupIdentification,
    selectionLevel: group.selectionLevel,
  };
}

export function resolveAudioSelection(tracks, identity, targetLevel, supported = () => true) {
  if (!identity || targetLevel === null) return null;
  const candidates = [...tracks].filter(track => track.kind === 'audio' &&
    track.contextId === identity.contextId && supported(track) &&
    matchingGroup(track, identity.groupIdentification, targetLevel));
  if (!candidates.length) return null;
  candidates.sort((left, right) =>
    (left.componentTag === identity.componentTag ? 0 : 1) -
      (right.componentTag === identity.componentTag ? 0 : 1) ||
    left.componentTag - right.componentTag || left.packetId - right.packetId);
  return {track: candidates[0], groupIdentification: identity.groupIdentification};
}

export function audioTrackChoices(tracks, supported = () => true) {
  const choices = new Map();
  for (const track of tracks) {
    if (track.kind !== 'audio' || !supported(track)) continue;
    const groups = track.assetGroups || [];
    if (!groups.length) {
      choices.set(`track:${track.packetId}`, {track, group: null});
      continue;
    }
    for (const group of groups) {
      const current = choices.get(group.groupIdentification);
      const currentLevel = current?.group.selectionLevel ?? Number.POSITIVE_INFINITY;
      if (!current || group.selectionLevel < currentLevel ||
          (group.selectionLevel === currentLevel && track.componentTag < current.track.componentTag)) {
        choices.set(group.groupIdentification, {track, group});
      }
    }
  }
  return [...choices.values()]
    .sort((left, right) => left.track.componentTag - right.track.componentTag)
    .map(({track, group}) => ({
      track,
      groupIdentification: group?.groupIdentification ?? null,
    }));
}

export function currentMptTracks(snapshotTracks, selectableTracks) {
  return [...snapshotTracks].filter(snapshotTrack => [...selectableTracks].some(selectable =>
    selectable.kind === snapshotTrack.kind && selectable.trackId === snapshotTrack.trackId &&
    selectable.packetId === snapshotTrack.packetId && selectable.contextId === snapshotTrack.contextId));
}

export function resolveLayerPair(tracks, currentVideo, currentAudio, activeAudioGroupId = null) {
  const available = [...tracks];
  const videos = available.filter(track => sameVideoLayerGroup(currentVideo, track))
    .sort((left, right) => (selectionLevel(left) ?? 0xff) - (selectionLevel(right) ?? 0xff));
  const preferredVideo = videos[0];
  if (!preferredVideo) return null;
  const preferred = correspondingAudioTrack(
    available, currentAudio, selectionLevel(preferredVideo), activeAudioGroupId,
  );
  if (!preferred) return null;
  const fallbackVideo = videos.find(track => selectionLevel(track) !== null &&
    selectionLevel(track) > (selectionLevel(preferredVideo) ?? 0xff));
  const fallback = fallbackVideo ? correspondingAudioTrack(
    available, currentAudio, selectionLevel(fallbackVideo), activeAudioGroupId,
  ) : null;
  return {
    preferred: {video: preferredVideo, audio: preferred.track,
      groupIdentification: preferred.groupIdentification},
    fallback: fallbackVideo && fallback ? {video: fallbackVideo, audio: fallback.track,
      groupIdentification: fallback.groupIdentification} : null,
  };
}

export async function configureAutomaticLayerPair(
  demuxer, pair, previousSignature, {manual = false, force = false} = {},
) {
  if (manual) {
    if (!pair?.fallback) {
      if (force || previousSignature !== 'disabled:unavailable') {
        await demuxer.clearAutomaticLayerSwitch();
      }
      return 'disabled:unavailable';
    }
    const signature = [
      pair.preferred.video.trackId, pair.preferred.audio.trackId,
      pair.fallback.video.trackId, pair.fallback.audio.trackId,
    ].join(':');
    const disabledSignature = `disabled:${signature}`;
    if (force || previousSignature !== disabledSignature) {
      await demuxer.suspendAutomaticLayerSwitch(
        pair.preferred.video.trackId, pair.preferred.audio.trackId,
        pair.fallback.video.trackId, pair.fallback.audio.trackId,
      );
    }
    return disabledSignature;
  }
  if (!pair?.fallback) {
    if (force || previousSignature !== 'unavailable') await demuxer.clearAutomaticLayerSwitch();
    return 'unavailable';
  }
  const signature = [
    pair.preferred.video.trackId, pair.preferred.audio.trackId,
    pair.fallback.video.trackId, pair.fallback.audio.trackId,
  ].join(':');
  if (force || signature !== previousSignature) {
    await demuxer.configureAutomaticLayerSwitch(
      pair.preferred.video.trackId, pair.preferred.audio.trackId,
      pair.fallback.video.trackId, pair.fallback.audio.trackId,
    );
  }
  return signature;
}

export function subtitleTrackKind(track) {
  if (track?.subtitle?.type === 0) return 'caption';
  if (track?.subtitle?.type === 1) return 'superimpose';
  const packetId = Number.isInteger(track?.packetId) ? `0x${track.packetId.toString(16)}` : 'unknown';
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
  return subtitleTrackKind(track) === 'superimpose' || track.trackId === selectedCaptionTrackId;
}
