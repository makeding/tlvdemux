import assert from 'node:assert/strict';
import {
  audioSelectionIdentity,
  audioTrackChoices,
  correspondingAudioTrack,
  preferredSeekVideoRap,
  resolveAudioSelection,
  sameVideoLayerGroup,
  selectionLevel,
  shouldReprobeVideoLayerForSeek,
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
assert.equal(preferredSeekVideoRap([
  {track: videoHigh, rap: {ptsUs: 33000000n}},
  {track: videoLow, rap: {ptsUs: 33200000n}},
], 500000n).track, videoHigh);
assert.equal(preferredSeekVideoRap([
  {track: videoHigh, rap: {ptsUs: 190000000n}},
  {track: videoLow, rap: {ptsUs: 237000000n}},
], 500000n).track, videoLow);
assert.equal(preferredSeekVideoRap([], 500000n), null);
assert.equal(shouldReprobeVideoLayerForSeek(videoLow, undefined), true,
  'automatic fallback seek did not request layer reprobe');
assert.equal(shouldReprobeVideoLayerForSeek(videoLow, 0xf301), false,
  'explicit fallback selection was overridden during seek');
assert.equal(shouldReprobeVideoLayerForSeek(videoHigh, undefined), false,
  'preferred layer seek unnecessarily requested a layer reprobe');

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
