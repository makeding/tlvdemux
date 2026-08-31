import assert from 'node:assert/strict';
import {open, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, resolve} from 'node:path';

import {
  MSE_SEEK_READ_BUDGET_BYTES,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs';

const readU32 = (data, offset) =>
  ((data[offset] * 0x1000000) + (data[offset + 1] << 16) +
   (data[offset + 2] << 8) + data[offset + 3]) >>> 0;
const readI32 = (data, offset) => readU32(data, offset) | 0;
const readU64 = (data, offset) =>
  BigInt(readU32(data, offset)) * 0x100000000n + BigInt(readU32(data, offset + 4));
const boxType = (data, offset) => String.fromCharCode(
  data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
);

function childBoxes(data, start = 0, end = data.byteLength) {
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    const size = readU32(data, offset);
    assert.ok(size >= 8 && offset + size <= end, `invalid MP4 box at ${offset}`);
    boxes.push({offset, size, type: boxType(data, offset)});
    offset += size;
  }
  return boxes;
}

function findDescendant(data, box, path) {
  let current = box;
  for (const wanted of path) {
    current = childBoxes(data, current.offset + 8, current.offset + current.size)
      .find(child => child.type === wanted);
    assert.ok(current, `MP4 box lacks ${wanted}`);
  }
  return current;
}

function initTimescale(data) {
  const moov = childBoxes(data).find(box => box.type === 'moov');
  assert.ok(moov, 'MSE init lacks moov');
  const mdhd = findDescendant(data, moov, ['trak', 'mdia', 'mdhd']);
  const version = data[mdhd.offset + 8];
  return readU32(data, mdhd.offset + (version === 1 ? 28 : 20));
}

function codedPresentationRange(data, timescale, timestampOffsetUs) {
  const moof = childBoxes(data).find(box => box.type === 'moof');
  assert.ok(moof, 'MSE media segment lacks moof');
  const traf = findDescendant(data, moof, ['traf']);
  const children = childBoxes(data, traf.offset + 8, traf.offset + traf.size);
  const tfdt = children.find(box => box.type === 'tfdt');
  const trun = children.find(box => box.type === 'trun');
  assert.ok(tfdt && trun, 'MSE media segment lacks tfdt/trun');
  const tfdtVersion = data[tfdt.offset + 8];
  let decodeTime = tfdtVersion === 1
    ? readU64(data, tfdt.offset + 12) : BigInt(readU32(data, tfdt.offset + 12));
  const trunVersion = data[trun.offset + 8];
  const sampleCount = readU32(data, trun.offset + 12);
  let entry = trun.offset + 20;
  let start = null;
  let end = null;
  for (let index = 0; index < sampleCount; index += 1, entry += 16) {
    const duration = BigInt(readU32(data, entry));
    const compositionOffset = BigInt(trunVersion === 1
      ? readI32(data, entry + 12) : readU32(data, entry + 12));
    const pts = decodeTime + compositionOffset;
    start = start === null || pts < start ? pts : start;
    const sampleEnd = pts + duration;
    end = end === null || sampleEnd > end ? sampleEnd : end;
    decodeTime += duration;
  }
  assert.ok(start !== null && end !== null, 'MSE media segment has no samples');
  return {
    start: Number(start * 1000000n / BigInt(timescale) + timestampOffsetUs) / 1000000,
    end: Number(end * 1000000n / BigInt(timescale) + timestampOffsetUs) / 1000000,
  };
}

const [modulePathArgument, mediaPathArgument, ...targetArguments] = process.argv.slice(2);
assert.ok(modulePathArgument && mediaPathArgument,
  'usage: node tests/wasm_seek_smoke.mjs TLVDEMUX_JS SAMPLE [TARGET_S ...]');
const targets = (targetArguments.length ? targetArguments : ['60', '200', '380']).map(Number);
assert.ok(targets.every(Number.isFinite), 'invalid seek target');
const readBudgetBytes = process.env.TLVDEMUX_SEEK_BUDGET_BYTES === undefined
  ? MSE_SEEK_READ_BUDGET_BYTES : Number(process.env.TLVDEMUX_SEEK_BUDGET_BYTES);
const authoritativeHeldFrameTargets = basename(mediaPathArgument) ===
  '20260731-102-170000_272b7cdc-8d85-4f77-91df-b935f3ae0e96.mmts'
  ? new Set([139.276545, 150.886703]) : new Set();

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
    const declaredRanges = {video: [], audio: []};
    const rawSegments = {video: [], audio: []};
    const timescales = {video: null, audio: null};
    const splices = {video: [], audio: []};
    const videoRecoveryEvents = [];
    const landingVideoUnits = [];
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
    const probeUnits = [];
    const probeClocks = [];
    const repositionCalls = [];
    const concealmentTargets = [];
    const previousSyncCalls = [];
    let readAttemptedAfterBudget = false;
    let session;
    let demuxer;
    demuxer = new module.TlvDemuxer({
      mseMaxAudioChannels: 8,
      onTrack(track) {
        tracks.set(track.trackId, track);
        session?.observeTrack(track);
        if (track.kind === 'video' && selectedVideo === null &&
            track.packetId === recordingRange.presentationStartVideoPacketId) {
          selectedVideo = track.trackId;
          selectedVideoTrack = track;
          // Worker selection can precede the forwarded onTrack callback; the
          // callback acknowledgement must be idempotent during a seek landing.
          demuxer.selectTrack('video', selectedVideo);
          demuxer.selectTrack('video', selectedVideo);
        } else if (track.kind === 'audio' && selectedAudio === null &&
            (track.audio?.channels === 0 || track.audio?.channels <= 8)) {
          selectedAudio = track.trackId;
          demuxer.selectTrack('audio', selectedAudio);
          demuxer.selectTrack('audio', selectedAudio);
        }
      },
      onTrackRemoved(track) {
        tracks.delete(track.trackId);
        session?.observeTrackRemoved(track);
        if (track.kind === 'video' && selectedVideo === track.trackId) {
          selectedVideo = null;
          selectedVideoTrack = null;
        } else if (track.kind === 'audio' && selectedAudio === track.trackId) {
          selectedAudio = null;
        }
      },
      onAccessUnit(unit) {
        if ((session?.phase === 'probe' || session?.phase === 'backward-plan') &&
            unit.codec === 'hevc' && probeUnits.length < 64) {
          probeUnits.push(`${unit.trackId}:${unit.ptsValue}/${unit.ptsTimescale}:` +
            `${unit.randomAccess}:${unit.restartOffset}:${unit.inputOffset}:` +
            `${session.bytesRead}`);
        }
        if (session?.phase === 'single-landing' && unit.codec === 'hevc' &&
            landingVideoUnits.length < 64) {
          landingVideoUnits.push({
            trackId: unit.trackId,
            ptsValue: unit.ptsValue,
            ptsTimescale: unit.ptsTimescale,
            dtsValue: unit.dtsValue ?? null,
            dtsTimescale: unit.dtsTimescale ?? null,
            randomAccess: unit.randomAccess,
            discontinuity: unit.discontinuity ?? null,
            discontinuityReason: unit.discontinuityReason ?? unit.reason ?? null,
            inputOffset: unit.inputOffset,
            restartOffset: unit.restartOffset,
            bytesRead: session.bytesRead,
          });
        }
        session?.observeAccessUnit(unit);
      },
      onMseVideoSplice(splice) {
        offsets.video = BigInt(splice.timestampOffsetUs ?? 0n);
        splices.video.push(splice);
      },
      onMseAudioSplice(splice) {
        offsets.audio = BigInt(splice.timestampOffsetUs ?? 0n);
        splices.audio.push(splice);
      },
      onMseVideoRecovery(event) { videoRecoveryEvents.push(event); },
      onBroadcastClock(clock) {
        if ((session?.phase === 'probe' || session?.phase === 'backward-plan') &&
            probeClocks.length < 64) {
          probeClocks.push(`${clock.mediaTimeValue}/${clock.mediaTimeTimescale}:` +
            `${clock.inputOffset}:${session.bytesRead}`);
        }
      },
      onMseInit(init) {
        if (init.type in timescales) timescales[init.type] = initTimescale(init.data);
      },
      onMseSegment(segment) {
        if (!(segment.type in ranges)) return;
        rawSegments[segment.type].push({
          startTimeUs: BigInt(segment.startTimeUs), endTimeUs: BigInt(segment.endTimeUs),
        });
        assert.ok(timescales[segment.type], `${segment.type} media preceded its init`);
        mergeRange(declaredRanges[segment.type], {
          start: Number(BigInt(segment.startTimeUs) + offsets[segment.type]) / 1000000,
          end: Number(BigInt(segment.endTimeUs) + offsets[segment.type]) / 1000000,
        });
        mergeRange(ranges[segment.type], codedPresentationRange(
          segment.data, timescales[segment.type], offsets[segment.type],
        ));
      },
      onError(error) {
        if (!error.recoverable) callbackError = new Error(error.message);
      },
    });
    const reposition = demuxer.reposition.bind(demuxer);
    demuxer.reposition = async (...args) => {
      repositionCalls.push({phase: session?.phase ?? 'bootstrap', args});
      return reposition(...args);
    };
    const setConcealmentTarget = demuxer.setMseRecordedSeekConcealmentTarget.bind(demuxer);
    demuxer.setMseRecordedSeekConcealmentTarget = async target => {
      concealmentTargets.push(target);
      return setConcealmentTarget(target);
    };
    if (typeof demuxer.previousSync === 'function') {
      const previousSync = demuxer.previousSync.bind(demuxer);
      demuxer.previousSync = async target => {
        const point = await previousSync(target);
        previousSyncCalls.push({phase: session?.phase ?? 'bootstrap', target, point});
        return point;
      };
    }
    demuxer.startIndex(false);
    const media = {currentTime: targetTimeSeconds};
    const flowControl = createMsePlaybackFlowControl({
      media, queues, entryKind: 'seek', entryTimeSeconds: targetTimeSeconds,
    });
    const source = {
      size: sourceSize,
      async read(offset, length) {
        const alreadyRequested = requests.reduce((sum, request) => sum + request.length, 0n);
        if (alreadyRequested >= BigInt(readBudgetBytes)) readAttemptedAfterBudget = true;
        requests.push({phase: session?.phase ?? 'duration', offset, length});
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
      readBudgetBytes,
    });
    try {
      let result;
      try {
        result = await session.run();
      } catch (error) {
        const landingEvidence = typeof demuxer.getMseRecordedSeekLandingEvidence === 'function'
          ? await demuxer.getMseRecordedSeekLandingEvidence() : null;
        error.message += ` target=${targetTimeSeconds}s requests=` + requests.map(request =>
          `${request.phase}:${request.offset}+${request.length}`).join(',') + ` tracks=${JSON.stringify(
            [...tracks.values()].filter(track => track.kind === 'video').map(track => ({
              trackId: String(track.trackId), packetId: String(track.packetId),
              selectionLevel: selectionLevel(track),
            })))} ranges=${JSON.stringify(ranges)} recovery=${JSON.stringify(videoRecoveryEvents,
              (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `declaredRanges=${JSON.stringify(declaredRanges)} units=${probeUnits.join(',')} ` +
          `clocks=${probeClocks.join(',')} presentationStartUs=${presentationStartUs} ` +
          `repositions=${JSON.stringify(repositionCalls,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `rawSegments=${JSON.stringify(rawSegments,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `splices=${JSON.stringify(splices,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `landingVideoUnits=${JSON.stringify(landingVideoUnits,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `concealmentTargets=${concealmentTargets.join(',')} landingEvidence=${JSON.stringify(
            landingEvidence, (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `previousSync=${JSON.stringify(previousSyncCalls,
            (_, value) => typeof value === 'bigint' ? value.toString() : value)}`;
        throw error;
      }
      const requested = requests.reduce((sum, request) => sum + request.length, 0n);
      assert.equal(requested, result.bytesRead);
      assert.ok(requested <= BigInt(readBudgetBytes),
        `seek ${targetTimeSeconds}s exceeded the 16 MiB budget`);
      assert.equal(readAttemptedAfterBudget, false,
        `seek ${targetTimeSeconds}s read after exhausting its shared budget`);
      const formalLandings = repositionCalls.filter(call => call.phase === 'single-landing');
      assert.equal(formalLandings.length, 1,
        `seek ${targetTimeSeconds}s performed ${formalLandings.length} formal landings`);
      assert.ok(result.rapPresentationTimeUs <= result.sourceTargetUs,
        `seek ${targetTimeSeconds}s selected a RAP after the target`);
      assert.equal(media.currentTime, targetTimeSeconds,
        `seek ${targetTimeSeconds}s replaced the requested MediaElement time`);
      const landingMode = result.landingMode ?? 'exact';
      assert.ok(landingMode === 'exact' || landingMode === 'held-frame',
        `seek ${targetTimeSeconds}s returned an unknown landing mode ${landingMode}`);
      if (authoritativeHeldFrameTargets.has(targetTimeSeconds)) {
        assert.equal(landingMode, 'held-frame',
          `seek ${targetTimeSeconds}s did not use its required natural-playback fallback`);
      }
      const targetRanges = Object.fromEntries(Object.entries(ranges).map(([type, items]) => [
        type,
        items.filter(range => range.start <= targetTimeSeconds + 0.000002 &&
          range.end >= targetTimeSeconds),
      ]));
      assert.ok(targetRanges.video.length > 0,
        `seek ${targetTimeSeconds}s did not retain video at the requested clock: ` +
        JSON.stringify(ranges));
      if (landingMode === 'exact') {
        assert.equal(flowControl.entryCovered(), true,
          `exact seek ${targetTimeSeconds}s did not form common A/V at the target`);
        assert.ok(targetRanges.audio.length > 0,
          `exact seek ${targetTimeSeconds}s did not retain exact audio target coverage: ` +
          JSON.stringify(ranges));
      } else {
        const heldFrameTimeSeconds = result.heldFrameTimeSeconds;
        const recoveryTimeSeconds = result.recoveryTimeSeconds;
        if (heldFrameTimeSeconds !== null && heldFrameTimeSeconds !== undefined ||
            recoveryTimeSeconds !== null && recoveryTimeSeconds !== undefined) {
          assert.ok(heldFrameTimeSeconds !== null && heldFrameTimeSeconds !== undefined,
            `video-held seek ${targetTimeSeconds}s omitted its held frame time`);
          assert.ok(heldFrameTimeSeconds <= targetTimeSeconds,
            `video-held seek ${targetTimeSeconds}s held a future frame`);
          assert.ok(recoveryTimeSeconds !== null && recoveryTimeSeconds !== undefined,
            `video-held seek ${targetTimeSeconds}s omitted its recovery time`);
          assert.ok(recoveryTimeSeconds > targetTimeSeconds,
            `video-held seek ${targetTimeSeconds}s did not schedule forward recovery`);
        } else {
          assert.ok(flowControl.heldFrameEntryRange() !== null,
            `audio-tail seek ${targetTimeSeconds}s omitted its bounded degraded range`);
        }
      }
      for (const [type, items] of Object.entries(splices)) {
        const zeroSplice = items.find(splice =>
          BigInt(splice.presentationTimeUs) + BigInt(splice.timestampOffsetUs ?? 0n) === 0n);
        assert.equal(zeroSplice, undefined,
          `seek ${targetTimeSeconds}s mapped ${type} back to playback entry zero`);
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
        requestedTimeSeconds: result.requestedTimeSeconds ?? targetTimeSeconds,
        landingMode,
        heldFrameTimeSeconds: result.heldFrameTimeSeconds ?? null,
        recoveryTimeSeconds: result.recoveryTimeSeconds ?? null,
        repositionCalls: repositionCalls.map(({phase, args: [offset, preserveTimeline]}) => ({
          phase, offset: offset.toString(), preserveTimeline,
        })),
        readAttemptedAfterBudget,
        probeClocks,
        previousSyncCalls,
        splices,
        rawSegments,
        landingVideoUnits,
        requests: requests.map(request => ({
          phase: request.phase,
          offset: request.offset.toString(),
          length: request.length.toString(),
        })),
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
