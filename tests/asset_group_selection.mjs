import assert from 'node:assert/strict';
import {correspondingAudioTrack, selectionLevel} from '../demo/asset-groups.mjs';

const track = (packetId, groups) => ({packetId, assetGroups: groups.map(
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

console.log('asset group selection test passed');
