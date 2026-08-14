import assert from 'node:assert/strict';
import {
  audioSelectionIdentity,
  audioTrackChoices,
  correspondingAudioTrack,
  resolveAudioSelection,
  selectionLevel,
} from '../demo/asset-groups.mjs';

const track = (packetId, groups, componentTag = packetId & 0xff) => ({
  kind: 'audio', contextId: 1, packetId, componentTag, assetGroups: groups.map(
  ([groupIdentification, selectionLevel]) => ({groupIdentification, selectionLevel}),
)});

const videoHigh = track(0xf300, [[0x00, 0]]);
const videoLow = track(0xf301, [[0x00, 1]]);
const audioMainHigh = track(0xf310, [[0x10, 0]]);
const audioSubHigh = track(0xf311, [[0x11, 0]]);
const audioMainLow = track(0xf314, [[0x10, 1]]);
const audioSubLow = track(0xf315, [[0x11, 1]]);
const audioSharedLow = track(0xf316, [[0x10, 1], [0x11, 1]]);

assert.equal(selectionLevel(videoHigh), 0);
assert.equal(selectionLevel(videoLow), 1);
assert.equal(selectionLevel({}), null);

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

console.log('asset group selection test passed');
