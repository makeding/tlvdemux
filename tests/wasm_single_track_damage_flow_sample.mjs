import assert from 'node:assert/strict';
import {closeSync, openSync, readSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

import {createMsePlaybackDamageRecovery} from '../mse-playback.mjs';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_single_track_damage_flow_sample.mjs MODULE SAMPLE');

const createModule = createRequire(import.meta.url)(resolve(modulePathArgument));
const module = await createModule();
const samplePath = resolve(samplePathArgument);

function probePresentationStartUs() {
  const probe = new module.DurationProbe();
  const descriptor = openSync(samplePath, 'r');
  try {
    assert.equal(probe.begin(BigInt(statSync(samplePath).size), {
      initialRangeSize: 4n * 1024n * 1024n,
      maxRangeSize: 64n * 1024n * 1024n,
    }), true);
    while (probe.state() === 'need-range') {
      const request = probe.nextRange();
      assert.ok(request, 'duration probe omitted its next range');
      const data = new Uint8Array(Number(request.length));
      const bytesRead = readSync(
        descriptor, data, 0, data.byteLength, Number(request.offset));
      assert.equal(probe.pushRange(
        request.requestId, request.offset, data.subarray(0, bytesRead), true), true);
    }
    assert.equal(probe.state(), 'complete', `duration probe failed: ${probe.failure()}`);
    const start = probe.presentationStart();
    assert.ok(start, 'duration probe omitted presentation start');
    return BigInt(start.value) * 1_000_000n / BigInt(start.timescale);
  } finally {
    closeSync(descriptor);
    probe.delete();
  }
}

const presentationStartUs = probePresentationStartUs();
const tracks = new Map();
const damages = [];
const sourceDamages = [];
const layerSwitches = [];
const videoRandomAccessUnits = [];
const videoSegments = [];
let selectedVideo = null;
let selectedAudio = null;
let demuxer;

demuxer = new module.TlvDemuxer({
  onTrack(track) {
    tracks.set(track.trackId, track);
    if (track.kind === 'video' && selectedVideo === null) {
      selectedVideo = track.trackId;
      demuxer.selectTrack('video', selectedVideo);
    } else if (track.kind === 'audio' && selectedAudio === null) {
      selectedAudio = track.trackId;
      demuxer.selectTrack('audio', selectedAudio);
    }
  },
  onPlaybackDamage(damage) { damages.push(damage); },
  onDamage(damage) { sourceDamages.push(damage); },
  onPlaybackAccessUnitView(unit) {
    if (unit.codec === 'hevc' && unit.randomAccess) videoRandomAccessUnits.push(unit);
  },
  onMseSegment(segment) {
    if (segment.type === 'video') {
      videoSegments.push({
        startTimeUs: BigInt(segment.startTimeUs),
        endTimeUs: BigInt(segment.endTimeUs),
      });
    }
  },
  onMseLayerSwitch(layerSwitch) { layerSwitches.push(layerSwitch); },
  onError(error) {
    if (!error.recoverable) throw new Error(`${error.code}: ${error.message}`);
  },
});

const input = openSync(samplePath, 'r');
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
    bytesReadTotal += bytesRead;
  }
  demuxer.flush();

  const videoTracks = [...tracks.values()].filter(track => track.kind === 'video');
  const audioTracks = [...tracks.values()].filter(track => track.kind === 'audio');
  assert.equal(videoTracks.length, 1, 'single-layer sample exposed a rainfall video fallback');
  assert.equal(videoTracks[0].packetId, 0xa140, 'single-layer sample video packet changed');
  assert.equal(audioTracks.length, 1, 'single-layer sample exposed an alternate audio track');
  assert.equal(audioTracks[0].packetId, 0xa141, 'single-layer sample audio packet changed');
  assert.deepEqual(layerSwitches, [], 'single-layer damage triggered a rainfall layer switch');

  const shortRecovery = damages.find(damage => damage.action === 'seek-if-stalled' &&
    damage.startTimeUs !== null && damage.recoveryTimeUs !== null &&
    damage.recoveryTimeUs > damage.startTimeUs);
  assert.ok(shortRecovery,
    `single-layer sample produced no seek-if-stalled authorization: ${JSON.stringify({
      playbackDamage: damages,
      sourceDamage: sourceDamages,
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
  assert.equal(shortRecovery.severity, 'warning');
  assert.notEqual(shortRecovery.startTimeUs, null);
  assert.notEqual(shortRecovery.recoveryTimeUs, null);
  assert.ok(shortRecovery.recoveryInputOffset > 0n);
  assert.ok(shortRecovery.recoveryRestartOffset > 0n);
  assert.ok(shortRecovery.recoveryTimeUs > shortRecovery.startTimeUs);
  assert.ok(shortRecovery.recoveryTimeUs - shortRecovery.startTimeUs < 2_000_000n);
  const sealedShortPrefix = videoSegments.find(segment =>
    segment.endTimeUs >= shortRecovery.startTimeUs &&
    segment.endTimeUs < shortRecovery.recoveryTimeUs);
  assert.ok(sealedShortPrefix,
    'source damage discarded the complete sub-second video prefix before recovery');
  assert.ok(videoSegments.some(segment =>
    segment.startTimeUs === shortRecovery.recoveryTimeUs),
  'video did not restart its MSE media at the parser-provided recovery RAP');

  const sixSecondRecovery = damages.find(damage => {
    if (damage.action !== 'seek-if-stalled' || damage.startTimeUs === null ||
        damage.recoveryTimeUs === null) return false;
    const mappedStart = damage.startTimeUs - presentationStartUs;
    const mappedRecovery = damage.recoveryTimeUs - presentationStartUs;
    return mappedStart <= 6_000_000n && mappedRecovery >= 6_000_000n;
  });
  assert.ok(sixSecondRecovery,
    'sample exposed no parser-provided recovery RAP covering the observed 0:06 stall');
  const nextForwardRap = videoRandomAccessUnits
    .map(unit => ({
      unit,
      mediaTime: Number(unit.ptsValue) / unit.ptsTimescale -
        Number(presentationStartUs) / 1_000_000,
    }))
    .filter(item => item.unit.trackId === selectedVideo && item.mediaTime >= 6.58)
    .sort((left, right) => left.mediaTime - right.mediaTime)[0];
  assert.ok(nextForwardRap, 'sample exposed no real forward RAP after the observed 6.580s stall');
  assert.equal(nextForwardRap.mediaTime.toFixed(6), '6.806806',
    'the authoritative forward recovery RAP changed');

  const jumps = [];
  const media = {
    currentTime: Number(shortRecovery.startTimeUs) / 1_000_000 + 0.001,
    paused: false,
    seeking: false,
    play() { return Promise.resolve(); },
  };
  const recovery = createMsePlaybackDamageRecovery({
    media,
    isCurrentLayer: damage => damage.videoTrackId === selectedVideo,
    seek(target, previous) {
      jumps.push({target, previous});
      media.currentTime = target;
    },
  });
  recovery.reportDamage(shortRecovery);
  assert.deepEqual(jumps, [], 'sample parser prefetch immediately executed seek-if-stalled');
  recovery.notifyWaiting();
  recovery.notifyWaiting();
  assert.equal(jumps.length, 1, 'sample waiting did not execute recovery exactly once');
  assert.equal(jumps[0].target, Number(shortRecovery.recoveryTimeUs) / 1_000_000,
    'sample waiting did not seek to the parser-provided recovery RAP');

  const delayedJumps = [];
  const stalledMedia = {
    currentTime: 6.58,
    paused: false,
    seeking: false,
    playCount: 0,
    play() { this.playCount += 1; this.paused = false; return Promise.resolve(); },
  };
  const delayedRecovery = createMsePlaybackDamageRecovery({
    media: stalledMedia,
    presentationStartUs,
    isCurrentLayer: damage => damage.videoTrackId === selectedVideo,
    seek(target, previous) {
      delayedJumps.push({target, previous});
      stalledMedia.currentTime = target;
      stalledMedia.paused = true;
    },
  });
  delayedRecovery.reportDamage(sixSecondRecovery);
  delayedRecovery.observePresentedFrame(
    Number(sixSecondRecovery.startTimeUs - presentationStartUs) / 1_000_000 - 0.01);
  delayedRecovery.notifyWaiting();
  assert.deepEqual(delayedJumps, [],
    'late waiting jumped backward to the already-passed first recovery RAP');
  delayedRecovery.observeAccessUnit(nextForwardRap.unit);
  assert.deepEqual(delayedJumps, [{
    target: nextForwardRap.mediaTime,
    previous: 6.58,
  }], 'the observed 6.580s waiting did not advance to the next real RAP');
  assert.equal(stalledMedia.playCount, 1,
    'the authoritative 6.580s recovery still required a manual play click');

  const thirteenSecondRecovery = damages.find(damage =>
    damage.action === 'seek-if-stalled' && damage.recoveryTimeUs !== null &&
    ((damage.recoveryTimeUs - presentationStartUs) / 1_000n) === 11_611n);
  assert.ok(thirteenSecondRecovery,
    'sample exposed no retained damage authorization for the observed 13.245s stall');
  const thirteenSecondRaps = videoRandomAccessUnits
    .map(unit => ({
      unit,
      mediaTime: Number(unit.ptsValue) / unit.ptsTimescale -
        Number(presentationStartUs) / 1_000_000,
    }))
    .filter(item => item.unit.trackId === selectedVideo && item.mediaTime >= 13.245)
    .sort((left, right) => left.mediaTime - right.mediaTime);
  assert.equal(thirteenSecondRaps[0]?.mediaTime.toFixed(6), '13.747079',
    'the first observed 13-second recovery RAP changed');
  assert.equal(thirteenSecondRaps[1]?.mediaTime.toFixed(6), '14.280934',
    'the second observed 13-second recovery RAP changed');

  let frameCallbackId = 0;
  const repeatedStallMedia = {
    currentTime: 13.245,
    paused: false,
    seeking: false,
    playCount: 0,
    play() { this.playCount += 1; this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback() { frameCallbackId += 1; return frameCallbackId; },
    cancelVideoFrameCallback() {},
  };
  const repeatedStallJumps = [];
  const repeatedStallRecovery = createMsePlaybackDamageRecovery({
    media: repeatedStallMedia,
    presentationStartUs,
    isCurrentLayer: damage => damage.videoTrackId === selectedVideo,
    seek(target, previous) {
      repeatedStallJumps.push({target, previous});
      repeatedStallMedia.currentTime = target;
      repeatedStallMedia.paused = true;
    },
  });
  repeatedStallRecovery.reportDamage(thirteenSecondRecovery);
  repeatedStallRecovery.observePresentedFrame(7.291);
  repeatedStallRecovery.observeAccessUnit(thirteenSecondRaps[0].unit);
  repeatedStallRecovery.observeAccessUnit(thirteenSecondRaps[1].unit);
  repeatedStallRecovery.notifyWaiting();
  repeatedStallRecovery.reportDamage(thirteenSecondRecovery);
  repeatedStallRecovery.notifyBufferedChange();
  assert.equal(repeatedStallJumps.length, 1,
    'the first 13-second recovery attempt was incorrectly completed or repeated');
  repeatedStallRecovery.notifyWaiting();
  assert.deepEqual(repeatedStallJumps, [
    {target: thirteenSecondRaps[0].mediaTime, previous: 13.245},
    {target: thirteenSecondRaps[1].mediaTime, previous: thirteenSecondRaps[0].mediaTime},
  ], 'the repeated 13.747s waiting did not advance to the next real RAP');
  assert.equal(repeatedStallMedia.playCount, 2,
    'repeated damage recovery did not resume playback after each SDK-owned seek');
  repeatedStallRecovery.observePresentedFrame(
    Number(thirteenSecondRecovery.recoveryTimeUs - presentationStartUs) / 1_000_000 + 0.01);
  repeatedStallRecovery.notifyWaiting();
  assert.equal(repeatedStallJumps.length, 2,
    'presented recovery video did not retire the 13-second authorization');
  repeatedStallRecovery.destroy();

  console.log(JSON.stringify({
    sample: samplePathArgument,
    bytesRead: bytesReadTotal,
    videoPacketId: `0x${videoTracks[0].packetId.toString(16)}`,
    audioPacketId: `0x${audioTracks[0].packetId.toString(16)}`,
    damageCount: damages.length,
    shortRecovery,
    jump: jumps[0],
    sixSecondRecovery,
    nextForwardRap: {
      mediaTime: nextForwardRap.mediaTime,
      ptsValue: nextForwardRap.unit.ptsValue,
      ptsTimescale: nextForwardRap.unit.ptsTimescale,
      restartOffset: nextForwardRap.unit.restartOffset,
    },
    delayedJump: delayedJumps[0],
    repeatedStallJumps,
    videoSegmentsNearFirstDamage: videoSegments.filter(segment =>
      segment.startTimeUs < shortRecovery.recoveryTimeUs + 1_000_000n &&
      segment.endTimeUs > shortRecovery.startTimeUs - 1_000_000n),
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} finally {
  closeSync(input);
  demuxer.delete();
  module._free(inputAddress);
}
