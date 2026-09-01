import assert from 'node:assert/strict';
import {open, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, resolve} from 'node:path';

import {
  MSE_SEEK_READ_BUDGET_BYTES,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs';

const [modulePathArgument, mediaPathArgument, ...targetArguments] = process.argv.slice(2);
assert.ok(modulePathArgument && mediaPathArgument,
  'usage: node tests/wasm_seek_smoke.mjs TLVDEMUX_JS SAMPLE [TARGET_S ...] ' +
  '[--seed N --random COUNT]');
const explicitTargetArguments = [];
let randomSeed = null;
let randomCount = 0;
for (let index = 0; index < targetArguments.length; index += 1) {
  if (targetArguments[index] === '--seed') {
    randomSeed = Number(targetArguments[++index]);
  } else if (targetArguments[index] === '--random') {
    randomCount = Number(targetArguments[++index]);
  } else {
    explicitTargetArguments.push(targetArguments[index]);
  }
}
assert.ok(randomSeed === null || Number.isInteger(randomSeed), 'invalid random seed');
assert.ok(Number.isInteger(randomCount) && randomCount >= 0, 'invalid random target count');

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
    const presentationStart = probe.presentationStart();
    const presentationEnd = probe.presentationEnd();
    assert.ok(duration && presentationStart && presentationEnd);
    const toMicroseconds = timestamp =>
      BigInt(timestamp.value) * 1000000n / BigInt(timestamp.timescale);
    return {
      durationUs: toMicroseconds(duration),
      presentationStartUs: toMicroseconds(presentationStart),
      presentationEndUs: toMicroseconds(presentationEnd),
      presentationStartVideoPacketId: probe.selectedVideoPacketId(),
      presentationEndVideoPacketId: probe.presentationEndVideoPacketId(),
    };
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
    committedRanges() { return ranges; },
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

const recordingRange = await probeDuration();
const {durationUs, presentationStartUs, presentationEndUs} = recordingRange;
const targets = (explicitTargetArguments.length
  ? explicitTargetArguments : ['60', '200', '380']).map(Number);
if (randomCount > 0) {
  let state = (randomSeed ?? 0x5e3a1) >>> 0;
  const usableDuration = Math.max(0, Number(durationUs) / 1000000 - 3);
  for (let index = 0; index < randomCount; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    targets.push(Number(((state / 0x100000000) * usableDuration).toFixed(6)));
  }
}
assert.ok(targets.length > 0 && targets.every(target =>
  Number.isFinite(target) && target >= 0 && target < Number(durationUs) / 1000000),
'invalid seek target');
assert.equal(durationUs, presentationEndUs - presentationStartUs,
  'duration probe did not return end - start for the video union');
if (basename(mediaPath) === 'rain.tlv') {
  assert.equal(presentationStartUs, 821_944n,
    'rain.tlv media time zero did not come from its first rainfall frame');
  assert.equal(presentationEndUs, 415_519_422n,
    'rain.tlv union did not retain the later video-track end');
  assert.equal(recordingRange.presentationStartVideoPacketId, 0xf301,
    'rain.tlv union start was not owned by the rainfall video track');
  assert.equal(recordingRange.presentationEndVideoPacketId, 0xf301,
    'rain.tlv union end owner changed unexpectedly');
}
const results = [];
try {
  for (const targetTimeSeconds of targets) {
    const tracks = new Map();
    const ranges = {video: [], audio: []};
    const videoRecoveryEvents = [];
    const damageEvents = [];
    const spliceEvents = [];
    const offsets = {video: -presentationStartUs, audio: -presentationStartUs};
    const queues = new Map([
      ['video', queue(ranges.video)],
      ['audio', queue(ranges.audio)],
    ]);
    const requests = [];
    let selectedVideo = null;
    let selectedAudio = null;
    let selectedVideoTrack = null;
    let callbackError = null;
    let timelineEstablished = false;
    const probeUnits = [];
    const audioUnits = [];
    const trackEvents = [];
    let session;
    let demuxer;
    demuxer = new module.TlvDemuxer({
      onTrack(track) {
        tracks.set(track.trackId, track);
        if (trackEvents.length < 64) {
          trackEvents.push({
            phase: session?.phase ?? 'setup', event: 'track', trackId: track.trackId,
            kind: track.kind, codec: track.codec,
            selectionLevels: (track.assetGroups ?? []).map(group => group.selectionLevel),
            groupIds: (track.assetGroups ?? []).map(group => group.groupIdentification),
          });
        }
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
        if (trackEvents.length < 64) {
          trackEvents.push({phase: session?.phase ?? 'setup', event: 'removed',
            trackId: track.trackId, kind: track.kind, codec: track.codec});
        }
        session?.observeTrackRemoved(track);
      },
      onAccessUnit(unit) {
        if (unit.ptsTimescale > 1 && (unit.codec === 'hevc' || unit.codec === 'aac-latm')) {
          timelineEstablished = true;
        }
        if ((session?.phase === 'bootstrap' || session?.phase === 'backward-plan') &&
            unit.codec === 'hevc' && probeUnits.length < 64) {
          probeUnits.push(`${unit.trackId}:${unit.ptsValue}/${unit.ptsTimescale}:` +
            `${unit.randomAccess}:${unit.restartOffset}:${session.phase}`);
        }
        if ((session?.phase === 'backward-plan' || session?.phase === 'single-landing') &&
            unit.codec === 'aac-latm') {
          if (audioUnits.length < 12 || unit.discontinuity) {
            audioUnits.push(`${unit.trackId}:${unit.ptsValue}/${unit.ptsTimescale}:` +
              `${unit.discontinuity}:${unit.restartOffset}:${session.phase}`);
          } else {
            audioUnits[audioUnits.length - 1] = `${unit.trackId}:${unit.ptsValue}/` +
              `${unit.ptsTimescale}:${unit.discontinuity}:${unit.restartOffset}:${session.phase}`;
          }
        }
        session?.observeAccessUnit(unit);
      },
      onMseVideoSplice(splice) {
        offsets.video = BigInt(splice.timestampOffsetUs ?? 0n);
        spliceEvents.push({type: 'video', ...splice});
      },
      onMseAudioSplice(splice) {
        offsets.audio = BigInt(splice.timestampOffsetUs ?? 0n);
        spliceEvents.push({type: 'audio', ...splice});
      },
      onMseVideoRecovery(event) { videoRecoveryEvents.push(event); },
      onDamage(damage) {
        damageEvents.push(damage);
        session?.observeDamage(damage);
      },
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
    demuxer.setIndexDuration(presentationEndUs);
    demuxer.setMseOutputEnabled(false);
    let startupOffset = 0n;
    while ((!timelineEstablished || selectedVideo === null || selectedAudio === null) &&
           startupOffset < sourceSize) {
      const startupData = await readRange(startupOffset, 1024n * 1024n);
      assert.ok(startupData.byteLength > 0, 'sequential startup ended before tracks/timeline');
      assert.equal(demuxer.push(startupData), true);
      startupOffset += BigInt(startupData.byteLength);
    }
    const media = {currentTime: targetTimeSeconds};
    const flowControl = createMsePlaybackFlowControl({
      media, queues, entryKind: 'seek', entryTimeSeconds: targetTimeSeconds,
      allowNaturalStart: targetTimeSeconds === 0,
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
      presentationStartUs,
      presentationEndUs,
      demuxer,
      media,
      queues,
      flowControl,
      headReady: () => selectedVideo !== null,
      initialTracks: [...tracks.values()],
      timelineEstablished: true,
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
          `${request.offset}+${request.length}`).join(',') + ` units=${probeUnits.join(',')}` +
          ` selectedVideo=${selectedVideo} tracks=${JSON.stringify(trackEvents,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)}` +
          ` ranges=${JSON.stringify(ranges)} splices=${JSON.stringify(spliceEvents,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)}` +
          ` audioUnits=${audioUnits.join(',')}` +
          ` recoveries=${JSON.stringify(videoRecoveryEvents,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)}` +
          ` damage=${JSON.stringify(damageEvents,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)}`;
        throw error;
      }
      const requested = requests.reduce((sum, request) => sum + request.length, 0n);
      assert.equal(requested, result.bytesRead);
      assert.equal(requests.some(request => request.offset === 0n), false,
        `seek ${targetTimeSeconds}s reread the file head on a reused demuxer`);
      assert.ok(requested <= result.maximumBudgetBytes,
        `seek ${targetTimeSeconds}s exceeded its resolution-aware hard limit`);
      assert.ok(result.budgetBytes >= BigInt(MSE_SEEK_READ_BUDGET_BYTES) &&
        result.budgetBytes <= result.maximumBudgetBytes,
      `seek ${targetTimeSeconds}s received an invalid landing authorization`);
      if (requested > BigInt(MSE_SEEK_READ_BUDGET_BYTES)) {
        assert.equal(result.budgetAuthorization.extended, true,
          `seek ${targetTimeSeconds}s read beyond the base budget without authorization`);
      }
      assert.ok(result.rapPresentationTimeUs <= result.sourceTargetUs,
        `seek ${targetTimeSeconds}s selected a RAP after the target`);
      assert.equal(media.currentTime, targetTimeSeconds,
        `seek ${targetTimeSeconds}s changed the requested media clock`);
      assert.equal(flowControl.entryCovered(), true,
        `seek ${targetTimeSeconds}s did not form common A/V at the target`);
      const targetRanges = Object.fromEntries(Object.entries(ranges).map(([type, items]) => [
        type,
        items.filter(range => range.start <= targetTimeSeconds + 0.001 &&
          range.end >= targetTimeSeconds + 0.001),
      ]));
      if (targetTimeSeconds === 0) {
        assert.equal(result.landingMode, 'natural-start',
          `seek 0s used ${result.landingMode}: ${JSON.stringify(ranges)}`);
        assert.ok(ranges.audio.some(range => range.start <= 0.000001 && range.end > 0) &&
          ranges.video[0]?.start > 0 && ranges.video[0]?.start < 1,
        `seek 0s did not retain audio at zero and a naturally later first video RAP: ` +
          JSON.stringify(ranges));
      } else {
        assert.equal(result.landingMode, 'exact');
        assert.ok(targetRanges.video.length > 0 && targetRanges.audio.length > 0,
          `seek ${targetTimeSeconds}s did not retain exact per-track target coverage: ` +
          JSON.stringify(ranges));
      }
      let damageStartUs = null;
      let concealed = false;
      for (const event of videoRecoveryEvents) {
        if (event.phase === 'observation-started') {
          damageStartUs = BigInt(event.presentationTimeUs);
        } else if (event.phase === 'stable-rap-committed' && damageStartUs !== null) {
          concealed = damageStartUs <= result.sourceTargetUs &&
            result.sourceTargetUs < BigInt(event.presentationTimeUs);
          damageStartUs = null;
        }
      }
      if (concealed) {
        assert.ok(Math.abs(targetRanges.video[0].start - targetTimeSeconds) <= 0.000002,
          `concealed video did not begin at exact target ${targetTimeSeconds}s`);
      }
      results.push({
        targetTimeSeconds,
        rapTimeSeconds: Number(result.rapPresentationTimeUs) / 1000000,
        restartOffset: result.restartOffset.toString(),
        nextOffset: result.nextOffset.toString(),
        bytesRead: result.bytesRead.toString(),
        landingMode: result.landingMode,
        targetRanges,
        concealed,
        videoRecoveryEvents,
      });
    } finally {
      demuxer.delete();
    }
  }
  console.log(JSON.stringify({
    durationUs: durationUs.toString(),
    presentationStartUs: presentationStartUs.toString(),
    presentationEndUs: presentationEndUs.toString(),
    presentationStartVideoPacketId: recordingRange.presentationStartVideoPacketId,
    presentationEndVideoPacketId: recordingRange.presentationEndVideoPacketId,
    seeks: results,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} finally {
  await input.close();
}
