import assert from 'node:assert/strict';
import {closeSync, openSync, readSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_full_sample_regression.mjs MODULE SAMPLE');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const initCounts = {video: 0, audio: 0};
const segmentCounts = {video: 0, audio: 0};
const accessUnitCounts = {video: 0, audio: 0, subtitle: 0};
const fatalErrors = [];
let selectedVideo = null;
let selectedAudio = null;
let demuxer;

demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    tracks.set(track.trackId, track);
    if (track.kind === 'video' && selectedVideo === null) {
      selectedVideo = track.trackId;
      demuxer.selectTrack('video', selectedVideo);
    } else if (track.kind === 'audio' && selectedAudio === null &&
               (track.audio?.channels === 0 || track.audio?.channels <= 6)) {
      selectedAudio = track.trackId;
      demuxer.selectTrack('audio', selectedAudio);
    }
  },
  onAccessUnitView(unit) {
    const track = tracks.get(unit.trackId);
    if (track && track.kind in accessUnitCounts) accessUnitCounts[track.kind] += 1;
  },
  onMseInit(init) { initCounts[init.type] += 1; },
  onMseSegment(segment) { segmentCounts[segment.type] += 1; },
  onError(error) { if (!error.recoverable) fatalErrors.push(error); },
});
demuxer.startIndex(false);

const input = openSync(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
const inputAddress = module._malloc(chunk.byteLength);
assert.ok(inputAddress, 'failed to allocate the reusable WASM input buffer');
let bytesReadTotal = 0;
try {
  for (;;) {
    const bytesRead = readSync(input, chunk, 0, chunk.byteLength, bytesReadTotal);
    if (bytesRead === 0) break;
    module.HEAPU8.set(chunk.subarray(0, bytesRead), inputAddress);
    assert.equal(demuxer.pushFromHeap(inputAddress, bytesRead), true);
    while (demuxer.drainApplicationResources(256)) {}
    bytesReadTotal += bytesRead;
  }
  demuxer.flush();
  while (demuxer.drainApplicationResources(256)) {}
  assert.equal(demuxer.finalizeIndex(), true);

  assert.deepEqual(fatalErrors, []);
  assert.notEqual(selectedVideo, null, 'sample exposed no HEVC video track');
  assert.notEqual(selectedAudio, null, 'sample exposed no AAC audio track');
  assert.ok(initCounts.video > 0 && segmentCounts.video > 0,
    `sample produced no complete video MSE output: ${JSON.stringify({initCounts, segmentCounts})}`);
  assert.ok(initCounts.audio > 0 && segmentCounts.audio > 0,
    `sample produced no complete audio MSE output: ${JSON.stringify({initCounts, segmentCounts})}`);
  assert.ok(accessUnitCounts.video > 0 && accessUnitCounts.audio > 0,
    `sample produced no selected A/V access units: ${JSON.stringify(accessUnitCounts)}`);
  const duration = demuxer.indexDuration();
  assert.equal(duration?.status, 'complete');
  const durationUs = BigInt(duration.value) * 1_000_000n / BigInt(duration.timescale);
  assert.ok(durationUs > 0n, 'full recording index has no media duration');
  assert.ok(demuxer.seekPointCount() > 0, 'full recording index contains no RAP');

  console.log(JSON.stringify({
    sample: samplePathArgument,
    bytesRead: bytesReadTotal,
    durationUs: durationUs.toString(),
    seekPoints: demuxer.seekPointCount(),
    tracks: tracks.size,
    accessUnits: accessUnitCounts,
    inits: initCounts,
    segments: segmentCounts,
  }));
} finally {
  closeSync(input);
  demuxer.delete();
  module._free(inputAddress);
}
