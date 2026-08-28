import assert from 'node:assert/strict';
import {open, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

import {
  MSE_SEEK_READ_BUDGET_BYTES,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs';

const [modulePathArgument, mediaPathArgument, ...targetArguments] = process.argv.slice(2);
assert.ok(modulePathArgument && mediaPathArgument,
  'usage: node tests/wasm_seek_smoke.mjs TLVDEMUX_JS SAMPLE [TARGET_S ...]');
const targets = (targetArguments.length ? targetArguments : ['60', '200', '380']).map(Number);
assert.ok(targets.every(Number.isFinite), 'invalid seek target');

const require = createRequire(import.meta.url);
const createTlvDemuxModule = require(resolve(modulePathArgument));
const module = await createTlvDemuxModule();
const mediaPath = resolve(mediaPathArgument);
const sourceSize = BigInt((await stat(mediaPath)).size);
const input = await open(mediaPath, 'r');

async function readRange(offset, length) {
  const data = new Uint8Array(Number(length));
  const {bytesRead} = await input.read(data, 0, data.byteLength, Number(offset));
  return data.subarray(0, bytesRead);
}

async function probeDuration() {
  const probe = new module.DurationProbe();
  try {
    assert.equal(probe.begin(sourceSize, {
      initialRangeSize: 2n * 1024n * 1024n,
      maxRangeSize: 16n * 1024n * 1024n,
    }), true);
    while (probe.state() === 'need-range') {
      const request = probe.nextRange();
      assert.ok(request, 'duration probe omitted its next range');
      const data = await readRange(request.offset, request.length);
      assert.equal(probe.pushRange(request.requestId, request.offset, data, true), true);
    }
    assert.equal(probe.state(), 'complete', `duration probe failed: ${probe.failure()}`);
    const duration = probe.duration();
    assert.ok(duration);
    return BigInt(duration.value) * 1000000n / BigInt(duration.timescale);
  } finally {
    probe.delete();
  }
}

function selectionLevel(track) {
  return track?.assetGroups?.[0]?.selectionLevel ?? 0;
}

function sameLayerGroup(left, right) {
  if (!left || !right || left.kind !== 'video' || right.kind !== 'video') return false;
  const leftIds = new Set((left.assetGroups ?? []).map(group => group.groupIdentification));
  return (right.assetGroups ?? []).some(group => leftIds.has(group.groupIdentification));
}

function correspondingAudio(tracks, current, video) {
  const level = selectionLevel(video);
  const groupIds = (current?.assetGroups ?? []).map(group => group.groupIdentification);
  return tracks.find(track => track.kind === 'audio' && track.assetGroups?.some(group =>
    groupIds.includes(group.groupIdentification) && group.selectionLevel === level)) ?? current;
}

function queue(ranges) {
  return {
    bufferedRanges() { return ranges; },
    trimBefore() {},
    waitFlowControlled() { return Promise.resolve(); },
    waitStable() { return Promise.resolve(); },
  };
}

function mergeRange(ranges, range, tolerance = 0.022) {
  ranges.push(range);
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length;) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.start > previous.end + tolerance) {
      index += 1;
      continue;
    }
    previous.end = Math.max(previous.end, current.end);
    ranges.splice(index, 1);
  }
}

const durationUs = await probeDuration();
const results = [];
try {
  for (const targetTimeSeconds of targets) {
    const tracks = new Map();
    const ranges = {video: [], audio: []};
    const offsets = {video: 0n, audio: 0n};
    const queues = new Map([
      ['video', queue(ranges.video)],
      ['audio', queue(ranges.audio)],
    ]);
    const requests = [];
    let selectedVideo = null;
    let selectedAudio = null;
    let selectedVideoTrack = null;
    let callbackError = null;
    const probeUnits = [];
    let session;
    let demuxer;
    demuxer = new module.TlvDemuxer({
      onTrack(track) {
        tracks.set(track.trackId, track);
        session?.observeTrack(track);
        if (track.kind === 'video' && selectedVideo === null) {
          selectedVideo = track.trackId;
          selectedVideoTrack = track;
          demuxer.selectTrack('video', selectedVideo);
        } else if (track.kind === 'audio' && selectedAudio === null) {
          selectedAudio = track.trackId;
          demuxer.selectTrack('audio', selectedAudio);
        }
      },
      onTrackRemoved(track) {
        tracks.delete(track.trackId);
        session?.observeTrackRemoved(track);
      },
      onAccessUnit(unit) {
        if (session?.phase === 'probe' && unit.codec === 'hevc' && probeUnits.length < 32) {
          probeUnits.push(`${unit.ptsValue}/${unit.ptsTimescale}:${unit.randomAccess}:${unit.restartOffset}`);
        }
        session?.observeAccessUnit(unit);
      },
      onMseVideoSplice(splice) { offsets.video = BigInt(splice.timestampOffsetUs ?? 0n); },
      onMseAudioSplice(splice) { offsets.audio = BigInt(splice.timestampOffsetUs ?? 0n); },
      onMseSegment(segment) {
        if (!(segment.type in ranges)) return;
        mergeRange(ranges[segment.type], {
          start: Number(BigInt(segment.startTimeUs) + offsets[segment.type]) / 1000000,
          end: Number(BigInt(segment.endTimeUs) + offsets[segment.type]) / 1000000,
        });
      },
      onError(error) {
        if (!error.recoverable) callbackError = new Error(error.message);
      },
    });
    demuxer.startIndex(false);
    const media = {currentTime: targetTimeSeconds};
    const flowControl = createMsePlaybackFlowControl({
      media, queues, entryKind: 'seek', entryTimeSeconds: targetTimeSeconds,
    });
    const source = {
      size: sourceSize,
      async read(offset, length) {
        requests.push({offset, length});
        return readRange(offset, length);
      },
    };
    session = createMseRecordedSeekSession({
      targetTimeSeconds,
      source,
      durationUs,
      demuxer,
      media,
      queues,
      flowControl,
      headReady: () => selectedVideo !== null,
      candidateVideoTrack: track => track.kind === 'video' &&
        (track.trackId === selectedVideo || sameLayerGroup(selectedVideoTrack, track)),
      videoTrackPriority: selectionLevel,
      activateVideoTrack: async track => {
        if (track.trackId === selectedVideo) return;
        const currentAudio = tracks.get(selectedAudio);
        const audio = correspondingAudio([...tracks.values()], currentAudio, track);
        selectedVideo = track.trackId;
        selectedVideoTrack = track;
        demuxer.selectTrack('video', selectedVideo);
        if (audio) {
          selectedAudio = audio.trackId;
          demuxer.selectTrack('audio', selectedAudio);
        }
      },
      checkError: () => { if (callbackError) throw callbackError; },
    });
    try {
      let result;
      try {
        result = await session.run();
      } catch (error) {
        error.message += ` target=${targetTimeSeconds}s requests=` + requests.map(request =>
          `${request.offset}+${request.length}`).join(',') + ` units=${probeUnits.join(',')}`;
        throw error;
      }
      const requested = requests.reduce((sum, request) => sum + request.length, 0n);
      assert.equal(requested, result.bytesRead);
      assert.ok(requested <= BigInt(MSE_SEEK_READ_BUDGET_BYTES),
        `seek ${targetTimeSeconds}s exceeded the 16 MiB budget`);
      assert.ok(result.rapPresentationTimeUs <= result.targetUs,
        `seek ${targetTimeSeconds}s selected a RAP after the target`);
      assert.equal(flowControl.entryCovered(), true,
        `seek ${targetTimeSeconds}s did not form common A/V at the target`);
      results.push({
        targetTimeSeconds,
        rapTimeSeconds: Number(result.rapPresentationTimeUs) / 1000000,
        restartOffset: result.restartOffset.toString(),
        nextOffset: result.nextOffset.toString(),
        bytesRead: result.bytesRead.toString(),
      });
    } finally {
      demuxer.delete();
    }
  }
  console.log(JSON.stringify({durationUs: durationUs.toString(), seeks: results}, null, 2));
} finally {
  await input.close();
}
