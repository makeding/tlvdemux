function matchingGroup(track, groupIdentification, selectionLevel = null) {
  return track?.assetGroups?.find(group =>
    (groupIdentification === null ||
      group.groupIdentification === groupIdentification) &&
    (selectionLevel === null || group.selectionLevel === selectionLevel)) ?? null;
}

export function selectionLevel(track, groupIdentification = null) {
  return matchingGroup(track, groupIdentification)?.selectionLevel ?? null;
}

export function correspondingAudioTrack(tracks, currentTrack, targetLevel, activeGroupId = null) {
  if (!currentTrack || targetLevel === null) return null;
  const currentGroups = currentTrack.assetGroups || [];
  const groupIds = [];
  if (activeGroupId !== null &&
      currentGroups.some(group => group.groupIdentification === activeGroupId)) {
    groupIds.push(activeGroupId);
  }
  for (const group of currentGroups) {
    if (!groupIds.includes(group.groupIdentification)) {
      groupIds.push(group.groupIdentification);
    }
  }
  for (const groupId of groupIds) {
    const track = [...tracks].find(candidate =>
      candidate.assetGroups?.some(group =>
        group.groupIdentification === groupId && group.selectionLevel === targetLevel));
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
  const candidates = [...tracks].filter(track =>
    track.kind === 'audio' && track.contextId === identity.contextId && supported(track) &&
    matchingGroup(track, identity.groupIdentification, targetLevel));
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const leftSameComponent = left.componentTag === identity.componentTag ? 0 : 1;
    const rightSameComponent = right.componentTag === identity.componentTag ? 0 : 1;
    return leftSameComponent - rightSameComponent ||
      left.componentTag - right.componentTag || left.packetId - right.packetId;
  });
  return {
    track: candidates[0],
    groupIdentification: identity.groupIdentification,
  };
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
