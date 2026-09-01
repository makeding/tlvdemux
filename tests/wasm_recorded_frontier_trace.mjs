import assert from 'node:assert/strict';
import {closeSync, openSync, readSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument, byteLimitText = `${512 * 1024 * 1024}`]
  = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_recorded_frontier_trace.mjs MODULE SAMPLE [BYTE_LIMIT]');
const byteLimit = Number(byteLimitText);
assert.ok(Number.isSafeInteger(byteLimit) && byteLimit > 0, 'BYTE_LIMIT must be positive');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const selected = {video: null, audio: null};
const frontiers = {video: null, audio: null};
const segmentCounts = {video: 0, audio: 0};
const initCounts = {video: 0, audio: 0};
const events = [];
const configurationEvents = [];
const boundarySegments = [];
const boundaryAccessUnits = [];
const discontinuityAccessUnits = [];
const recoveryEvents = [];
const fatalErrors = [];
let inputOffset = 0;
let demuxer;

const serializable = value => JSON.parse(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const record = (kind, detail) => {
  const event = {inputOffset, kind, detail: serializable(detail)};
  events.push(event);
  if (kind === 'init' || kind.includes('splice') || kind.includes('switch')) {
    configurationEvents.push(event);
  }
};
const updateFrontier = segment => {
  const end = BigInt(segment.endTimeUs);
  if (frontiers[segment.type] === null || end > frontiers[segment.type]) {
    frontiers[segment.type] = end;
  }
};
const accessUnitTimeUs = (value, timescale) =>
  BigInt(value) * 1_000_000n / BigInt(timescale);
const accessUnitDetail = unit => ({
  trackId: unit.trackId,
  codec: unit.codec,
  dtsUs: accessUnitTimeUs(unit.dtsValue, unit.dtsTimescale),
  ptsUs: accessUnitTimeUs(unit.ptsValue, unit.ptsTimescale),
  durationUs: unit.durationValue === undefined || unit.durationTimescale === undefined
    ? null
    : accessUnitTimeUs(unit.durationValue, unit.durationTimescale),
  randomAccess: unit.randomAccess,
  discontinuity: unit.discontinuity,
  discontinuityReasons: unit.discontinuityReasons,
  byteLength: unit.data.byteLength,
});
const report = (details = false) => process.stdout.write(`${JSON.stringify({
  inputOffset,
  selected: Object.fromEntries(Object.entries(selected).map(([type, id]) =>
    [type, id === null ? null : id.toString()])),
  frontiersUs: Object.fromEntries(Object.entries(frontiers).map(([type, value]) =>
    [type, value === null ? null : value.toString()])),
  segmentCounts: {...segmentCounts},
  initCounts: {...initCounts},
  configurationEvents: details ? configurationEvents : configurationEvents.length,
  boundarySegments: details ? boundarySegments : boundarySegments.length,
  boundaryAccessUnits: details ? boundaryAccessUnits : boundaryAccessUnits.length,
  discontinuityAccessUnits: details ? discontinuityAccessUnits : discontinuityAccessUnits.length,
  recoveryEvents: details ? recoveryEvents : recoveryEvents.length,
  recentEvents: events.slice(-12),
  fatalErrors,
})}\n`);

demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    tracks.set(track.trackId, track);
    record('track', {
      trackId: track.trackId, packetId: track.packetId, kind: track.kind,
      codec: track.codec, width: track.video?.width, height: track.video?.height,
      sampleRate: track.audio?.sampleRate, channels: track.audio?.channels,
      assetGroups: track.assetGroups,
    });
    if (track.kind === 'video' && selected.video === null) {
      selected.video = track.trackId;
      demuxer.selectTrack('video', track.trackId);
    } else if (track.kind === 'audio' && selected.audio === null &&
               (track.audio?.channels === 0 || track.audio?.channels <= 6)) {
      selected.audio = track.trackId;
      demuxer.selectTrack('audio', track.trackId);
    }
  },
  onMseInit(init) {
    initCounts[init.type] += 1;
    record('init', {
      type: init.type, mime: init.mime, width: init.width, height: init.height,
      sampleRate: init.sampleRate, channels: init.channels,
    });
  },
  onMseSegment(segment) {
    segmentCounts[segment.type] += 1;
    updateFrontier(segment);
    const start = BigInt(segment.startTimeUs);
    const end = BigInt(segment.endTimeUs);
    if (start < 17_000_000n && end > 9_000_000n) {
      const detail = {
        type: segment.type,
        startTimeUs: start,
        endTimeUs: end,
        byteLength: segment.data.byteLength,
      };
      boundarySegments.push({inputOffset, ...serializable(detail)});
      record('segment', detail);
    }
  },
  onPlaybackAccessUnitView(unit) {
    if (unit.trackId !== selected.video && unit.trackId !== selected.audio) return;
    const detail = accessUnitDetail(unit);
    if (detail.ptsUs >= 14_000_000n && detail.ptsUs <= 18_000_000n) {
      boundaryAccessUnits.push({inputOffset, ...serializable(detail)});
    }
    if (unit.discontinuity) {
      discontinuityAccessUnits.push({inputOffset, ...serializable(detail)});
    }
  },
  onMseAudioSplice(splice) { record('audio-splice', splice); },
  onMseVideoSplice(splice) { record('video-splice', splice); },
  onMseLayerSwitchStarted(event) { record('layer-switch-started', event); },
  onMseLayerSwitch(event) { record('layer-switch', event); },
  onMseLayerSwitchCancelled(event) { record('layer-switch-cancelled', event); },
  onMseVideoRecovery(event) {
    record('video-recovery', event);
    recoveryEvents.push({inputOffset, kind: 'video-recovery', detail: serializable(event)});
  },
  onDamage(damage) {
    record('source-damage', damage);
    recoveryEvents.push({inputOffset, kind: 'source-damage', detail: serializable(damage)});
  },
  onPlaybackDamage(damage) {
    record('playback-damage', damage);
    recoveryEvents.push({inputOffset, kind: 'playback-damage', detail: serializable(damage)});
  },
  onError(error) {
    record(error.recoverable ? 'warning' : 'fatal-error', error);
    if (!error.recoverable) fatalErrors.push(serializable(error));
  },
});

const input = openSync(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
const inputAddress = module._malloc(chunk.byteLength);
assert.ok(inputAddress, 'failed to allocate the reusable WASM input buffer');
const reportStep = 32 * 1024 * 1024;
let nextReport = reportStep;
try {
  while (inputOffset < byteLimit) {
    const request = Math.min(chunk.byteLength, byteLimit - inputOffset);
    const bytesRead = readSync(input, chunk, 0, request, inputOffset);
    if (bytesRead === 0) break;
    module.HEAPU8.set(chunk.subarray(0, bytesRead), inputAddress);
    assert.equal(demuxer.pushFromHeap(inputAddress, bytesRead), true);
    while (demuxer.drainApplicationResources(256)) {}
    inputOffset += bytesRead;
    if (inputOffset >= nextReport) {
      report();
      nextReport += reportStep;
    }
  }
  report(true);
  assert.deepEqual(fatalErrors, []);
} finally {
  closeSync(input);
  demuxer.delete();
  module._free(inputAddress);
}
