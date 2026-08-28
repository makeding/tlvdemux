import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

import {configureAutomaticLayerPair} from '../track-selection.mjs';

const [modulePathArgument, samplePathArgument, expectedResult = 'restore'] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_manual_auto_layer_sample.mjs DIST_JS SAMPLE [restore|defer]');
assert.ok(expectedResult === 'restore' || expectedResult === 'defer',
  'expected result must be restore or defer');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const starts = [];
const completions = [];
const cancellations = [];
const videoSplices = [];
const audioSplices = [];
let selected = false;
let manualRequested = false;
let automaticRequested = false;
let automaticSignature = null;
let lastVideoEndUs = 0n;
let signature = 'disabled';
let demuxer;

demuxer = new module.TlvDemuxer({
  onTrack(track) {
    tracks.set(track.packetId, track);
    const highVideo = tracks.get(0xf300);
    const highAudio = tracks.get(0xf310);
    if (!selected && highVideo && highAudio) {
      demuxer.selectTrack('video', highVideo.trackId);
      demuxer.selectTrack('audio', highAudio.trackId);
      selected = true;
    }
  },
  onMseSegment(segment) {
    if (segment.type === 'video' && BigInt(segment.endTimeUs) > lastVideoEndUs) {
      lastVideoEndUs = BigInt(segment.endTimeUs);
    }
  },
  onMseLayerSwitchStarted(started) { starts.push(started); },
  onMseLayerSwitch(completed) { completions.push(completed); },
  onMseLayerSwitchCancelled(cancelled) { cancellations.push(cancelled); },
  onMseVideoSplice(splice) { videoSplices.push(splice); },
  onMseAudioSplice(splice) { audioSplices.push(splice); },
  onError(error) { if (!error.recoverable) throw new Error(error.message); },
});

const input = await open(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(128 * 1024);
try {
  for (let position = 0; ; position += chunk.byteLength) {
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    if (!bytesRead) break;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);

    const highVideo = tracks.get(0xf300);
    const highAudio = tracks.get(0xf310);
    const lowVideo = tracks.get(0xf301);
    const lowAudio = tracks.get(0xf314);
    if (!manualRequested && highVideo && highAudio && lowVideo && lowAudio) {
      signature = await configureAutomaticLayerPair(demuxer, {
        preferred: {video: highVideo, audio: highAudio, groupIdentification: 0x10},
        fallback: {video: lowVideo, audio: lowAudio, groupIdentification: 0x10},
      }, signature, {manual: true, force: true});
      assert.equal(demuxer.switchLayerAtPlaybackEntry(
        lowVideo.trackId, lowAudio.trackId, 0n,
      ), true, 'manual rainfall selection was rejected');
      manualRequested = true;
    }
    if (!automaticRequested && completions[0]?.videoTrackId === lowVideo?.trackId) {
      const pair = {
        preferred: {video: highVideo, audio: highAudio, groupIdentification: 0x10},
        fallback: {video: lowVideo, audio: lowAudio, groupIdentification: 0x10},
      };
      automaticSignature = await configureAutomaticLayerPair(demuxer, pair, signature);
      signature = automaticSignature;
      automaticRequested = true;
    }
    const outputTimestampOffsetUs = videoSplices.length
      ? BigInt(videoSplices.at(-1).timestampOffsetUs) : 0n;
    const outputPlayheadUs = lastVideoEndUs + outputTimestampOffsetUs;
    demuxer.setMsePlaybackPosition(outputPlayheadUs > 0n ? outputPlayheadUs : 0n);
    if (expectedResult === 'restore' && automaticRequested &&
        completions[1]?.videoTrackId === highVideo?.trackId) break;
    if (expectedResult === 'defer' && automaticRequested &&
        position >= 32 * 1024 * 1024) break;
  }
  demuxer.flush();
} finally {
  await input.close();
  demuxer.delete();
}

const highVideo = tracks.get(0xf300);
const highAudio = tracks.get(0xf310);
const lowVideo = tracks.get(0xf301);
const diagnostic = JSON.stringify({
  lastVideoEndUs: String(lastVideoEndUs),
  starts,
  completions,
  cancellations,
  videoSplices,
  audioSplices,
}, (_, value) => typeof value === 'bigint' ? value.toString() : value);
assert.equal(manualRequested, true, 'sample never requested the manual rainfall layer');
assert.equal(completions[0]?.videoTrackId, lowVideo.trackId,
  'manual rainfall layer did not complete');
assert.equal(BigInt(videoSplices[0].presentationTimeUs) +
  BigInt(videoSplices[0].timestampOffsetUs), 0n,
  `manual rainfall video did not map startup to timestamp zero: ${diagnostic}`);
assert.equal(BigInt(audioSplices[0].presentationTimeUs) +
  BigInt(audioSplices[0].timestampOffsetUs), 0n,
  `manual rainfall audio did not map startup to timestamp zero: ${diagnostic}`);
assert.equal(automaticSignature,
  `${highVideo.trackId}:${highAudio.trackId}:${lowVideo.trackId}:${tracks.get(0xf314).trackId}`,
  'automatic mode did not reactivate the preferred/fallback pair');
if (expectedResult === 'restore') {
  assert.equal(starts[1]?.videoTrackId, highVideo.trackId,
    'automatic mode did not stage preferred video');
  assert.equal(starts[1]?.audioTrackId, highAudio.trackId,
    'automatic mode did not stage corresponding preferred audio');
  assert.equal(completions[1]?.videoTrackId, highVideo.trackId,
    `automatic mode did not complete preferred video restoration: ${diagnostic}`);
  assert.equal(completions[1]?.audioTrackId, highAudio.trackId,
    'automatic mode did not complete preferred audio restoration');
  assert.equal(videoSplices[1]?.timestampOffsetUs, videoSplices[0]?.timestampOffsetUs,
    'automatic preferred restoration did not preserve the established MSE timeline');
  assert.equal(audioSplices[1]?.timestampOffsetUs, audioSplices[0]?.timestampOffsetUs,
    'automatic preferred audio did not preserve the established MSE timeline');
} else {
  assert.equal(starts.length, 1,
    `not-yet-healthy preferred layer started a switch from usable rainfall: ${diagnostic}`);
  assert.equal(completions.length, 1,
    `not-yet-healthy preferred layer replaced usable rainfall: ${diagnostic}`);
}
assert.deepEqual(cancellations, [], 'completed manual/automatic round trip was cancelled');

console.log(JSON.stringify({
  manualRainfallBoundaryUs: String(completions[0].videoPresentationTimeUs),
  automaticPreferredBoundaryUs: completions[1]
    ? String(completions[1].videoPresentationTimeUs) : null,
  expectedResult,
  starts: starts.map(item => ({
    videoTrackId: String(item.videoTrackId),
    audioTrackId: String(item.audioTrackId),
    reason: item.reason,
  })),
}, null, 2));
