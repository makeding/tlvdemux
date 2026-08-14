import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument,
  expectedDurationArgument = '375.625221'] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_layer_switch_full_sample.mjs DIST_JS SAMPLE [DURATION_S]');
const expectedDurationUs = BigInt(Math.round(Number(expectedDurationArgument) * 1000000));

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
let selected = false;
let automaticConfigured = false;
let completedLayer = null;
let cancelledLayer = null;
let lastVideoEndUs = null;
let lastAudioEndUs = null;
const segmentRanges = {video: [], audio: []};

function largestGap(ranges) {
  const ordered = [...ranges].sort((left, right) =>
    left.startUs === right.startUs ? 0 : left.startUs < right.startUs ? -1 : 1);
  let endUs = ordered[0]?.endUs ?? 0n;
  let gapUs = 0n;
  for (const range of ordered.slice(1)) {
    if (range.startUs > endUs) gapUs = range.startUs - endUs > gapUs
      ? range.startUs - endUs : gapUs;
    if (range.endUs > endUs) endUs = range.endUs;
  }
  return gapUs;
}

function largestGapInWindow(ranges, startUs, endUs) {
  const ordered = [...ranges].sort((left, right) =>
    left.startUs === right.startUs ? 0 : left.startUs < right.startUs ? -1 : 1);
  let coveredUs = startUs;
  let gapUs = 0n;
  for (const range of ordered) {
    if (range.endUs <= startUs) continue;
    if (range.startUs >= endUs) break;
    const rangeStartUs = range.startUs < startUs ? startUs : range.startUs;
    const rangeEndUs = range.endUs > endUs ? endUs : range.endUs;
    if (rangeStartUs > coveredUs) {
      const gap = rangeStartUs - coveredUs;
      if (gap > gapUs) gapUs = gap;
    }
    if (rangeEndUs > coveredUs) coveredUs = rangeEndUs;
  }
  if (coveredUs < endUs && endUs - coveredUs > gapUs) gapUs = endUs - coveredUs;
  return gapUs;
}

function largestGapDetailInWindow(ranges, startUs, endUs) {
  const ordered = [...ranges].sort((left, right) =>
    left.startUs === right.startUs ? 0 : left.startUs < right.startUs ? -1 : 1);
  let coveredUs = startUs;
  let largest = {startUs, endUs: startUs, durationUs: 0n};
  for (const range of ordered) {
    if (range.endUs <= startUs) continue;
    if (range.startUs >= endUs) break;
    const rangeStartUs = range.startUs < startUs ? startUs : range.startUs;
    const rangeEndUs = range.endUs > endUs ? endUs : range.endUs;
    if (rangeStartUs > coveredUs && rangeStartUs - coveredUs > largest.durationUs) {
      largest = {
        startUs: coveredUs,
        endUs: rangeStartUs,
        durationUs: rangeStartUs - coveredUs,
      };
    }
    if (rangeEndUs > coveredUs) coveredUs = rangeEndUs;
  }
  if (coveredUs < endUs && endUs - coveredUs > largest.durationUs) {
    largest = {startUs: coveredUs, endUs, durationUs: endUs - coveredUs};
  }
  return largest;
}

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
    const lowVideo = tracks.get(0xf301);
    const lowAudio = tracks.get(0xf314);
    if (selected && !automaticConfigured && highVideo && highAudio && lowVideo && lowAudio) {
      demuxer.configureAutomaticLayerSwitch(
        highVideo.trackId, highAudio.trackId, lowVideo.trackId, lowAudio.trackId,
      );
      automaticConfigured = true;
    }
  },
  onMseSegment(segment) {
    segmentRanges[segment.type]?.push({
      startUs: BigInt(segment.startTimeUs),
      endUs: BigInt(segment.endTimeUs),
    });
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
  }
  demuxer.flush();
  assert.equal(demuxer.finalizeIndex(), true);

  assert.equal(selected, true, 'initial high-quality A/V pair was not selected');
  assert.equal(automaticConfigured, true, 'automatic layer pair was not configured');
  assert.notEqual(completedLayer, null,
    `full-file layer switch did not complete: ${JSON.stringify({
      automaticConfigured,
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
  assert.ok(videoBoundaryUs < 200000000n,
    `quality-scored fallback switched too late at ${videoBoundaryUs}us`);
  assert.ok(videoBoundaryUs > 120000000n,
    `startup traffic triggered fallback at ${videoBoundaryUs}us`);

  const minimumEndUs = expectedDurationUs - 1000000n;
  assert.ok(lastVideoEndUs !== null && lastVideoEndUs >= minimumEndUs,
    'replacement video did not reach the expected recording tail');
  assert.ok(lastAudioEndUs !== null && lastAudioEndUs >= minimumEndUs,
    'replacement audio did not reach the expected recording tail');
  const largestVideoGapUs = largestGap(segmentRanges.video);
  const largestAudioGapUs = largestGap(segmentRanges.audio);
  assert.ok(largestVideoGapUs < 35000000n,
    `automatic fallback left a ${largestVideoGapUs}us video gap`);
  assert.ok(largestAudioGapUs < 35000000n,
    `automatic fallback left a ${largestAudioGapUs}us audio gap`);
  const switchWindowEndUs = videoBoundaryUs + 30000000n;
  const switchWindowVideoGapUs = largestGapInWindow(
    segmentRanges.video, videoBoundaryUs, switchWindowEndUs);
  const switchWindowAudioGapUs = largestGapInWindow(
    segmentRanges.audio, audioBoundaryUs, switchWindowEndUs);
  const switchWindowAudioGap = largestGapDetailInWindow(
    segmentRanges.audio, audioBoundaryUs, switchWindowEndUs);
  assert.ok(switchWindowVideoGapUs < 1000000n,
    `automatic fallback left a ${switchWindowVideoGapUs}us video gap near the switch`);
  assert.ok(switchWindowAudioGapUs < 1000000n,
    `automatic fallback left a ${switchWindowAudioGapUs}us audio gap near the switch`);
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
    largestVideoGapUs: largestVideoGapUs.toString(),
    largestAudioGapUs: largestAudioGapUs.toString(),
    switchWindowVideoGapUs: switchWindowVideoGapUs.toString(),
    switchWindowAudioGapUs: switchWindowAudioGapUs.toString(),
    switchWindowAudioGap: {
      startUs: switchWindowAudioGap.startUs.toString(),
      endUs: switchWindowAudioGap.endUs.toString(),
    },
    indexDurationUs: durationUs.toString(),
    seekPointCount: demuxer.seekPointCount(),
  }, null, 2));
} finally {
  await input.close();
  demuxer.delete();
}
