import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_audio_damage_flow_sample.mjs DIST_JS SAMPLE');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const ranges = {video: [], audio: []};
const fatalErrors = [];
let selectedVideo = null;
let selectedAudio = null;
let audioDiscontinuities = 0;
const audioDiscontinuityReasons = new Map();
const playbackDamage = [];
let demuxer;

function merged(input, toleranceUs = 22_000n) {
  const ordered = [...input].sort((left, right) => left.startUs < right.startUs ? -1 : 1);
  const output = [];
  for (const range of ordered) {
    const previous = output.at(-1);
    if (!previous || range.startUs > previous.endUs + toleranceUs) output.push({...range});
    else if (range.endUs > previous.endUs) previous.endUs = range.endUs;
  }
  return output;
}

function longestCommonUs() {
  let longest = 0n;
  for (const video of merged(ranges.video)) {
    for (const audio of merged(ranges.audio)) {
      const start = video.startUs > audio.startUs ? video.startUs : audio.startUs;
      const end = video.endUs < audio.endUs ? video.endUs : audio.endUs;
      if (end > start && end - start > longest) longest = end - start;
    }
  }
  return longest;
}

demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    if (track.kind === 'video' && selectedVideo === null) {
      selectedVideo = track.trackId;
      demuxer.selectTrack('video', selectedVideo);
    } else if (track.kind === 'audio' && selectedAudio === null &&
               (track.audio?.channels === 0 || track.audio?.channels <= 6)) {
      selectedAudio = track.trackId;
      demuxer.selectTrack('audio', selectedAudio);
    }
  },
  onPlaybackAccessUnitView(unit) {
    if (unit.codec === 'aac-latm' && unit.discontinuity) {
      audioDiscontinuities += 1;
      const reasons = Number(unit.discontinuityReasons ?? 0);
      audioDiscontinuityReasons.set(reasons,
        (audioDiscontinuityReasons.get(reasons) ?? 0) + 1);
    }
  },
  onMseSegment(segment) {
    if (!(segment.type in ranges)) return;
    ranges[segment.type].push({
      startUs: BigInt(segment.startTimeUs),
      endUs: BigInt(segment.endTimeUs),
    });
  },
  onPlaybackDamage(damage) { playbackDamage.push(damage); },
  onError(error) { if (!error.recoverable) fatalErrors.push(error); },
});

const input = await open(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
let position = 0;
try {
  while (position < 64 * 1024 * 1024) {
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);
    position += bytesRead;
  }
  demuxer.flush();

  const commonUs = longestCommonUs();
  const videoRanges = merged(ranges.video);
  const audioRanges = merged(ranges.audio);
  const longestAudioUs = audioRanges.reduce((longest, range) => {
    const duration = range.endUs - range.startUs;
    return duration > longest ? duration : longest;
  }, 0n);
  const summary = {
    bytesRead: position,
    audioDiscontinuities,
    audioDiscontinuityReasons: Object.fromEntries(audioDiscontinuityReasons),
    commonUs: commonUs.toString(),
    longestAudioUs: longestAudioUs.toString(),
    playbackDamage: playbackDamage.map(damage => ({
      action: damage.action,
      recoveryTimeUs: damage.recoveryTimeUs === null
        ? null : String(damage.recoveryTimeUs),
      videoTrackId: String(damage.videoTrackId),
    })),
    videoRanges: videoRanges.map(range => ({
      startUs: range.startUs.toString(), endUs: range.endUs.toString(),
    })),
    audioRanges: audioRanges.map(range => ({
      startUs: range.startUs.toString(), endUs: range.endUs.toString(),
    })),
  };
  assert.deepEqual(fatalErrors, []);
  assert.ok(audioDiscontinuities >= 20,
    `sample did not exercise repeated AAC discontinuities: ${audioDiscontinuities}`);
  assert.ok(longestAudioUs >= 10_000_000n,
    `AAC damage still fragmented the selected audio timeline: ${JSON.stringify(summary)}`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await input.close();
  demuxer.delete();
}
