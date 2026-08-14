export function selectionLevel(track) {
  return track?.assetGroups?.[0]?.selectionLevel ?? null;
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
