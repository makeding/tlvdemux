function matchingGroup(track, groupIdentification, selectionLevel = null) {
  return track?.assetGroups?.find(group =>
    (groupIdentification === null ||
      group.groupIdentification === groupIdentification) &&
    (selectionLevel === null || group.selectionLevel === selectionLevel)) ?? null;
}

export function selectionLevel(track, groupIdentification = null) {
  const group = matchingGroup(track, groupIdentification);
  if (group) return group.selectionLevel;
  return track?.kind === 'video' && groupIdentification === null &&
    !(track.assetGroups?.length) ? 0 : null;
}

export function sameVideoLayerGroup(left, right) {
  if (!left || !right || left.kind !== 'video' || right.kind !== 'video') return false;
  if (left.contextId !== undefined && right.contextId !== undefined &&
      left.contextId !== right.contextId) return false;
  const leftGroups = left.assetGroups || [];
  const rightGroups = right.assetGroups || [];
  if (!leftGroups.length && !rightGroups.length) return false;
  if (!leftGroups.length || !rightGroups.length) return true;
  return leftGroups.some(leftGroup =>
    rightGroups.some(rightGroup =>
      leftGroup.groupIdentification === rightGroup.groupIdentification));
}

export function automaticLayerSwitchEligible(
  currentTrack, currentPtsUs, candidateTrack, candidateRapPtsUs, lagUs,
  allowQualityUpgrade = true,
) {
  if (currentPtsUs === undefined || candidateRapPtsUs === undefined ||
      !sameVideoLayerGroup(currentTrack, candidateTrack)) return false;
  const currentLevel = selectionLevel(currentTrack) ?? 0xff;
  const candidateLevel = selectionLevel(candidateTrack) ?? 0xff;
  if (candidateLevel < currentLevel && !allowQualityUpgrade) return false;
  return candidateLevel < currentLevel
    ? candidateRapPtsUs + lagUs >= currentPtsUs
    : candidateRapPtsUs > currentPtsUs + lagUs;
}

export function preferredSeekVideoRap(candidates, maximumLagUs) {
  const video = [...candidates].filter(candidate =>
    candidate.track?.kind === 'video' && candidate.rap?.ptsUs !== undefined);
  if (!video.length) return null;
  const latestPtsUs = video.reduce(
    (latest, candidate) => candidate.rap.ptsUs > latest ? candidate.rap.ptsUs : latest,
    video[0].rap.ptsUs,
  );
  return video
    .filter(candidate => latestPtsUs - candidate.rap.ptsUs <= maximumLagUs)
    .sort((left, right) =>
      (selectionLevel(left.track) ?? 0xff) - (selectionLevel(right.track) ?? 0xff) ||
      (left.rap.ptsUs === right.rap.ptsUs ? 0 : left.rap.ptsUs > right.rap.ptsUs ? -1 : 1))[0];
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
