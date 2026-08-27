import assert from 'node:assert/strict';
import {open, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_startup_flow_control_sample.mjs DIST_JS SAMPLE');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const ranges = {video: [], audio: []};
const offsets = {video: 0n, audio: 0n};
const videoInits = [];
let selected = false;
let configured = false;
let switchStarted = null;
let switchCompleted = null;

function merged(input, toleranceUs = 22000n) {
  const ordered = [...input].sort((left, right) =>
    left.startUs < right.startUs ? -1 : left.startUs > right.startUs ? 1 : 0);
  const output = [];
  for (const range of ordered) {
    const previous = output.at(-1);
    if (!previous || range.startUs > previous.endUs + toleranceUs) {
      output.push({...range});
    } else if (range.endUs > previous.endUs) {
      previous.endUs = range.endUs;
    }
  }
  return output;
}

function commonAheadUs() {
  const video = merged(ranges.video);
  const audio = merged(ranges.audio);
  let maximum = 0n;
  for (const left of video) {
    for (const right of audio) {
      const start = left.startUs > right.startUs ? left.startUs : right.startUs;
      const end = left.endUs < right.endUs ? left.endUs : right.endUs;
      if (start <= 50000n && end > maximum) maximum = end;
    }
  }
  return maximum;
}

let demuxer;
demuxer = new module.TlvDemuxer({
  onTrack(track) {
    tracks.set(track.packetId, track);
    const highVideo = tracks.get(0xf300);
    const highAudio = tracks.get(0xf310);
    const lowVideo = tracks.get(0xf301);
    const lowAudio = tracks.get(0xf314);
    if (!selected && highVideo && highAudio) {
      demuxer.selectTrack('video', highVideo.trackId);
      demuxer.selectTrack('audio', highAudio.trackId);
      selected = true;
    }
    if (!configured && selected && highVideo && highAudio && lowVideo && lowAudio) {
      demuxer.configureAutomaticLayerSwitch(
        highVideo.trackId, highAudio.trackId, lowVideo.trackId, lowAudio.trackId);
      configured = true;
    }
  },
  onMseVideoSplice(splice) {
    offsets.video = BigInt(splice.timestampOffsetUs);
  },
  onMseAudioSplice(splice) {
    offsets.audio = BigInt(splice.timestampOffsetUs);
  },
  onMseInit(init) {
    if (init.type === 'video') videoInits.push(init);
  },
  onMseSegment(segment) {
    const type = segment.type;
    if (!(type in ranges)) return;
    ranges[type].push({
      startUs: BigInt(segment.startTimeUs) + offsets[type],
      endUs: BigInt(segment.endTimeUs) + offsets[type],
    });
  },
  onMseLayerSwitchStarted(layer) {
    switchStarted ??= layer;
  },
  onMseLayerSwitch(layer) {
    switchCompleted ??= layer;
  },
  onError(error) {
    if (!error.recoverable) throw new Error(error.message);
  },
});

const samplePath = resolve(samplePathArgument);
const sampleSize = BigInt((await stat(samplePath)).size);
const input = await open(samplePath, 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
let position = 0;
let firstCommonPosition = null;
try {
  while (commonAheadUs() < 15000000n) {
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    assert.ok(bytesRead > 0, 'startup flow-control reached EOF before 15 seconds of A/V');
    demuxer.setMsePlaybackPosition(0n);
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);
    position += bytesRead;
    if (firstCommonPosition === null && commonAheadUs() > 0n) {
      firstCommonPosition = position;
    }
    assert.ok(position <= 64 * 1024 * 1024,
      'startup prefetch exceeded 64 MiB before reaching the 15-second high-water mark');
  }

  assert.ok(firstCommonPosition !== null && firstCommonPosition <= 16 * 1024 * 1024,
    `startup common A/V exceeded the 16 MiB no-progress budget: ${firstCommonPosition}`);
  assert.ok(BigInt(position) < sampleSize,
    'startup flow-control consumed the recording to EOF');
  assert.equal(BigInt(switchStarted.earliestPresentationTimeUs), 0n);
  assert.equal(BigInt(switchCompleted.videoPresentationTimeUs), 821944n);
  assert.equal(offsets.video, -821944n);
  assert.equal(offsets.audio, -821944n);
  assert.equal(videoInits[0].width, 1920);
  assert.equal(videoInits[0].height, 1080);
  assert.match(videoInits[0].mime, /L123/);
  assert.ok(commonAheadUs() >= 15000000n);

  console.log(JSON.stringify({
    bytesRead: position,
    firstCommonBytes: firstCommonPosition,
    commonAheadUs: commonAheadUs().toString(),
    sourceBoundaryUs: String(switchCompleted.videoPresentationTimeUs),
    timestampOffsetUs: offsets.video.toString(),
    sampleSize: sampleSize.toString(),
  }, null, 2));
} finally {
  await input.close();
  demuxer.delete();
}
