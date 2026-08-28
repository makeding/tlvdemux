import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../worker/demux-worker-runtime.js', import.meta.url), 'utf8');
const context = {
  TlvDemuxWorkerProtocol: {},
  importScripts() {},
  postMessage() {},
  setTimeout() {},
  self: {},
};
context.globalThis = context;
vm.runInNewContext(`${source}\n` +
  'globalThis.__trackSelectionTest = {' +
  'rememberSelection, rememberLayerSelection, rememberLayerSwitchStarted, ' +
  'rememberLayerSwitchFinished, reconcileMptSelection};', context);

const {
  rememberSelection,
  rememberLayerSelection,
  rememberLayerSwitchStarted,
  rememberLayerSwitchFinished,
  reconcileMptSelection,
} = context.__trackSelectionTest;
const group = (groupIdentification, selectionLevel) =>
  ({groupIdentification, selectionLevel});
const track = (kind, trackId, packetId, componentTag, assetGroups) => ({
  kind, trackId: BigInt(trackId), packetId, componentTag, contextId: 1, assetGroups,
  audio: kind === 'audio' ? {channels: 2} : undefined,
});

const highVideo = track('video', 1, 0xf300, 0x00, [group(0x00, 0)]);
const lowVideo = track('video', 2, 0xf301, 0x01, [group(0x00, 1)]);
const highAudio = track('audio', 3, 0xf310, 0x10, [group(0x10, 0)]);
const lowAudio = track('audio', 4, 0xf314, 0x14, [group(0x10, 1)]);
const reboundLowAudio = track('audio', 5, 0xe314, 0x14, [group(0x10, 1)]);

const selections = [];
const record = {
  instance: {selectTrack: (kind, trackId) => selections.push([kind, trackId])},
  tracks: new Map([
    [lowVideo.trackId, lowVideo],
    [lowAudio.trackId, lowAudio],
  ]),
  selection: {
    maxAudioChannels: 6,
    videoTrack: null,
    videoPacketId: null,
    videoIdentity: null,
    audioTrack: null,
    audioPacketId: null,
    audioIdentity: null,
    subtitleTrack: null,
    subtitlePacketId: null,
    subtitleIdentity: null,
  },
};
rememberSelection(record, 'video', lowVideo);
rememberSelection(record, 'audio', lowAudio, 0x10);

record.tracks.set(highVideo.trackId, highVideo);
record.tracks.set(highAudio.trackId, highAudio);
rememberLayerSelection(record, highVideo.trackId, highAudio.trackId);
assert.equal(record.selection.videoTrack, highVideo.trackId);
assert.equal(record.selection.videoPacketId, highVideo.packetId);
assert.equal(record.selection.audioTrack, highAudio.trackId);
assert.equal(record.selection.audioPacketId, highAudio.packetId);
rememberLayerSelection(record, lowVideo.trackId, lowAudio.trackId);

rememberLayerSwitchStarted(record, {
  videoTrackId: highVideo.trackId,
  audioTrackId: highAudio.trackId,
  previousVideoTrackId: lowVideo.trackId,
  previousAudioTrackId: lowAudio.trackId,
  reason: 'source-damage',
});
assert.equal(record.layerSwitch.reason, 'source-damage');
assert.equal(record.selection.videoTrack, highVideo.trackId);
assert.equal(record.selection.audioTrack, highAudio.trackId);
rememberLayerSwitchFinished(record);
assert.equal(record.layerSwitch, null);
rememberLayerSelection(record, lowVideo.trackId, lowAudio.trackId);

reconcileMptSelection(record, {tracks: [lowVideo, reboundLowAudio]});
assert.deepEqual(selections, [['audio', reboundLowAudio.trackId]]);
assert.equal(record.selection.audioTrack, reboundLowAudio.trackId);
assert.equal(record.selection.audioPacketId, reboundLowAudio.packetId);
assert.equal(record.selection.audioIdentity.groupIdentification, 0x10);
assert.equal(record.selection.audioIdentity.selectionLevel, 1);

selections.length = 0;
record.tracks.set(lowVideo.trackId, lowVideo);
record.tracks.set(reboundLowAudio.trackId, reboundLowAudio);
rememberSelection(record, 'video', highVideo);
rememberSelection(record, 'audio', highAudio, 0x10);
reconcileMptSelection(record, {tracks: [lowVideo, lowAudio]});
assert.deepEqual(selections, [
  ['video', lowVideo.trackId],
  ['audio', lowAudio.trackId],
]);
assert.equal(record.selection.videoIdentity.selectionLevel, 1);
assert.equal(record.selection.audioIdentity.groupIdentification, 0x10);

console.log('worker track selection tests passed');
