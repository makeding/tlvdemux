import assert from 'node:assert/strict';
import {
  automaticLayerSwitchEligible,
  audioSelectionIdentity,
  audioTrackChoices,
  correspondingAudioTrack,
  preferredSeekVideoRap,
  qualityUpgradeReady,
  restartVideoTrackQualityWindow,
  resolveAudioSelection,
  sameVideoLayerGroup,
  selectionLevel,
  updateVideoTrackProgress,
} from '../demo/asset-groups.mjs';

const track = (packetId, groups, componentTag = packetId & 0xff) => ({
  kind: 'audio', contextId: 1, packetId, componentTag, assetGroups: groups.map(
  ([groupIdentification, selectionLevel]) => ({groupIdentification, selectionLevel}),
)});

const videoHigh = {kind: 'video', contextId: 1, packetId: 0xf300, componentTag: 0,
  assetGroups: [{groupIdentification: 0x00, selectionLevel: 0}]};
const videoLow = {kind: 'video', contextId: 1, packetId: 0xf301, componentTag: 1,
  assetGroups: [{groupIdentification: 0x00, selectionLevel: 1}]};
const videoBase = {kind: 'video', contextId: 1, packetId: 0xf302, componentTag: 0,
  assetGroups: []};
const audioMainHigh = track(0xf310, [[0x10, 0]]);
const audioSubHigh = track(0xf311, [[0x11, 0]]);
const audioMainLow = track(0xf314, [[0x10, 1]]);
const audioSubLow = track(0xf315, [[0x11, 1]]);
const audioSharedLow = track(0xf316, [[0x10, 1], [0x11, 1]]);

assert.equal(selectionLevel(videoHigh), 0);
assert.equal(selectionLevel(videoLow), 1);
assert.equal(selectionLevel(videoBase), 0);
assert.equal(selectionLevel({}), null);
assert.equal(sameVideoLayerGroup(videoBase, videoLow), true);
assert.equal(sameVideoLayerGroup(videoHigh, videoLow), true);
assert.equal(sameVideoLayerGroup(videoBase, {...videoBase, packetId: 0xf303}), false);
const lag = 2000000n;
assert.equal(automaticLayerSwitchEligible(videoHigh, 10000000n, videoLow, 12000001n, lag), true);
assert.equal(automaticLayerSwitchEligible(videoHigh, 10000000n, videoLow, 12000000n, lag), false);
assert.equal(automaticLayerSwitchEligible(videoLow, 10000000n, videoHigh, 8000000n, lag), true);
assert.equal(automaticLayerSwitchEligible(
  videoLow, 10000000n, videoHigh, 8000000n, lag, false), false);
assert.equal(automaticLayerSwitchEligible(videoLow, 10000000n, videoHigh, 7999999n, lag), false);
assert.equal(automaticLayerSwitchEligible(videoLow, 10000000n,
  {...videoHigh, contextId: 2}, 10000000n, lag), false);

let highProgress = updateVideoTrackProgress(
  {}, 10000000n, 10000000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 11500000n, 11500000n, true, true, 500000n,
);
assert.equal(qualityUpgradeReady(highProgress, 11500000n, 500000n, 2000000n), false,
  'a discontinuous high-quality layer was allowed to upgrade immediately');
highProgress = updateVideoTrackProgress(
  highProgress, 12000000n, 12000000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 12500000n, 12500000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 13000000n, 13000000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 13500000n, 13500000n, true, false, 500000n,
);
assert.equal(qualityUpgradeReady(highProgress, 13500000n, 500000n, 2000000n), true,
  'a high-quality layer did not recover after two clean seconds');
highProgress = restartVideoTrackQualityWindow(highProgress);
assert.equal(qualityUpgradeReady(highProgress, 13500000n, 500000n, 2000000n), false,
  'clean history from before a downgrade was reused as recovery evidence');
highProgress = updateVideoTrackProgress(
  highProgress, 14000000n, 14000000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 14500000n, 14500000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 15000000n, 15000000n, true, false, 500000n,
);
highProgress = updateVideoTrackProgress(
  highProgress, 15500000n, 15500000n, true, false, 500000n,
);
assert.equal(qualityUpgradeReady(highProgress, 15500000n, 500000n, 2000000n), true,
  'a reset high-quality layer did not recover from new clean data');
highProgress = updateVideoTrackProgress(
  highProgress, 15400000n, 15400000n, true, false, 500000n,
);
assert.equal(qualityUpgradeReady(highProgress, 15400000n, 500000n, 2000000n), false,
  'a backwards decode timestamp did not reset high-quality recovery');

let reorderedProgress = updateVideoTrackProgress(
  {}, 10000000n, 9900000n, true, false, 500000n,
);
reorderedProgress = updateVideoTrackProgress(
  reorderedProgress, 9800000n, 9933367n, false, false, 500000n,
);
assert.equal(reorderedProgress.lastPtsUs, 10000000n,
  'normal B-frame presentation reordering moved the track frontier backwards');
assert.equal(reorderedProgress.continuousSinceDtsUs, 9900000n,
  'normal B-frame presentation reordering reset decode continuity');

assert.equal(preferredSeekVideoRap([
  {track: videoHigh, rap: {ptsUs: 33000000n}},
  {track: videoLow, rap: {ptsUs: 33200000n}},
], 500000n).track, videoHigh);
assert.equal(preferredSeekVideoRap([
  {track: videoHigh, rap: {ptsUs: 190000000n}},
  {track: videoLow, rap: {ptsUs: 237000000n}},
], 500000n).track, videoLow);
assert.equal(preferredSeekVideoRap([], 500000n), null);

const ordinaryTracks = [audioMainHigh, audioSubHigh, audioMainLow, audioSubLow];
assert.deepEqual(correspondingAudioTrack(
  ordinaryTracks, audioMainHigh, selectionLevel(videoLow)),
{track: audioMainLow, groupIdentification: 0x10});
assert.deepEqual(correspondingAudioTrack(
  ordinaryTracks, audioSubLow, selectionLevel(videoHigh)),
{track: audioSubHigh, groupIdentification: 0x11});

const sharedTracks = [audioMainHigh, audioSubHigh, audioSharedLow];
assert.deepEqual(correspondingAudioTrack(sharedTracks, audioSharedLow, 0, 0x11),
  {track: audioSubHigh, groupIdentification: 0x11});
assert.equal(correspondingAudioTrack([audioMainHigh], audioMainHigh, 1), null);

const identity = audioSelectionIdentity(audioMainHigh, 0x10);
assert.deepEqual(identity, {
  contextId: 1,
  componentTag: 0x10,
  groupIdentification: 0x10,
  selectionLevel: 0,
});
assert.deepEqual(resolveAudioSelection(ordinaryTracks, identity, 1), {
  track: audioMainLow,
  groupIdentification: 0x10,
});

const reboundMainHigh = {...audioMainHigh, trackId: 99n, packetId: 0xe210};
assert.equal(resolveAudioSelection([reboundMainHigh], identity, 0).track, reboundMainHigh);
assert.equal(resolveAudioSelection([audioSubHigh], identity, 0), null);
assert.deepEqual(resolveAudioSelection(sharedTracks,
  audioSelectionIdentity(audioSubHigh, 0x11), 1), {
  track: audioSharedLow,
  groupIdentification: 0x11,
});

assert.deepEqual(audioTrackChoices(ordinaryTracks), [
  {track: audioMainHigh, groupIdentification: 0x10},
  {track: audioSubHigh, groupIdentification: 0x11},
]);
assert.deepEqual(audioTrackChoices([audioMainLow, audioSubLow]), [
  {track: audioMainLow, groupIdentification: 0x10},
  {track: audioSubLow, groupIdentification: 0x11},
]);
const ordinaryAudio = track(0xf320, []);
assert.deepEqual(audioTrackChoices([ordinaryAudio]), [
  {track: ordinaryAudio, groupIdentification: null},
]);

console.log('asset group selection test passed');
