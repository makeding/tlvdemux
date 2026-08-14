import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument, switchSecondsArgument = '171',
  expectedDurationArgument = '375.625221'] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_layer_switch_full_sample.mjs DIST_JS SAMPLE [SWITCH_S] [DURATION_S]');
const switchTimeUs = BigInt(Math.round(Number(switchSecondsArgument) * 1000000));
const expectedDurationUs = BigInt(Math.round(Number(expectedDurationArgument) * 1000000));

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
let selected = false;
let switchRequested = false;
let switchRequestProgressUs = null;
let completedLayer = null;
let cancelledLayer = null;
let lastVideoEndUs = null;
let lastAudioEndUs = null;

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
    const endUs = BigInt(segment.endTimeUs);
    if (segment.type === 'video') {
      lastVideoEndUs = lastVideoEndUs === null || endUs > lastVideoEndUs
        ? endUs : lastVideoEndUs;
    } else if (segment.type === 'audio') {
      lastAudioEndUs = lastAudioEndUs === null || endUs > lastAudioEndUs
        ? endUs : lastAudioEndUs;
    }
  },
  onMseLayerSwitch(layer) {
    completedLayer = layer;
  },
  onMseLayerSwitchCancelled(layer) {
    cancelledLayer = layer;
  },
  onError(error) {
    if (!error.recoverable) throw new Error(error.message);
  },
});
demuxer.startIndex(false);

const input = await open(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
try {
  for (let position = 0; ; position += chunk.byteLength) {
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    if (!bytesRead) break;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);

    const lowVideo = tracks.get(0xf301);
    const lowAudio = tracks.get(0xf314);
    if (!switchRequested && lowVideo && lowAudio &&
        lastVideoEndUs !== null && lastVideoEndUs >= switchTimeUs) {
      assert.equal(demuxer.switchLayer(
        lowVideo.trackId, lowAudio.trackId, switchTimeUs,
      ), true);
      switchRequested = true;
      switchRequestProgressUs = lastVideoEndUs;
    }
  }
  demuxer.flush();
  assert.equal(demuxer.finalizeIndex(), true);

  assert.equal(selected, true, 'initial high-quality A/V pair was not selected');
  assert.equal(switchRequested, true, 'lower layer was not requested at the sample boundary');
  assert.notEqual(completedLayer, null,
    `full-file layer switch did not complete: ${JSON.stringify({
      switchRequestProgressUs: switchRequestProgressUs?.toString(),
      cancelledLayer,
      lastVideoEndUs: lastVideoEndUs?.toString(),
      lastAudioEndUs: lastAudioEndUs?.toString(),
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
  const videoBoundaryUs = BigInt(completedLayer.videoPresentationTimeUs);
  const audioBoundaryUs = BigInt(completedLayer.audioPresentationTimeUs);
  const boundaryDifferenceUs = videoBoundaryUs > audioBoundaryUs
    ? videoBoundaryUs - audioBoundaryUs : audioBoundaryUs - videoBoundaryUs;
  assert.ok(boundaryDifferenceUs <= 500000n,
    `layer switch A/V boundary differs by ${boundaryDifferenceUs}us`);

  const minimumEndUs = expectedDurationUs - 1000000n;
  assert.ok(lastVideoEndUs !== null && lastVideoEndUs >= minimumEndUs,
    'replacement video did not reach the expected recording tail');
  assert.ok(lastAudioEndUs !== null && lastAudioEndUs >= minimumEndUs,
    'replacement audio did not reach the expected recording tail');
  const duration = demuxer.indexDuration();
  assert.equal(duration?.status, 'complete');
  const durationUs = BigInt(duration.value) * 1000000n / BigInt(duration.timescale);
  assert.ok(durationUs >= minimumEndUs,
    'recording index duration stopped at the retired high-quality layer');
  assert.ok(demuxer.seekPointCount() > 0, 'switched recording index has no RAP entries');

  console.log(JSON.stringify({
    videoBoundaryUs: videoBoundaryUs.toString(),
    audioBoundaryUs: audioBoundaryUs.toString(),
    lastVideoEndUs: lastVideoEndUs.toString(),
    lastAudioEndUs: lastAudioEndUs.toString(),
    indexDurationUs: durationUs.toString(),
    seekPointCount: demuxer.seekPointCount(),
  }, null, 2));
} finally {
  await input.close();
  demuxer.delete();
}
