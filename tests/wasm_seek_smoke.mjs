import assert from 'node:assert/strict';
import {open, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, resolve} from 'node:path';

import {
  MSE_RECORDED_READ_BUDGET_BYTES,
  createMseRecordedWindowLocator,
} from '../mse-recorded-playback.mjs';

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
    const timescales = {video: null, audio: null};
    const splices = {video: [], audio: []};
    const outputOrder = [];
    const videoRecoveryEvents = [];
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
    let locator;
    let demuxer;
    demuxer = new module.TlvDemuxer({
      mseMaxAudioChannels: 6,
      onTrack(track) {
        tracks.set(track.trackId, track);
        if (track.kind === 'video' && selectedVideo === null &&
            track.packetId === recordingRange.presentationStartVideoPacketId) {
          selectedVideo = track.trackId;
          selectedVideoTrack = track;
          // Worker selection can precede the forwarded onTrack callback; the
          // callback acknowledgement must be idempotent during a seek landing.
          demuxer.selectTrack('video', selectedVideo);
          demuxer.selectTrack('video', selectedVideo);
        } else if (track.kind === 'audio' && selectedAudio === null &&
            ((track.audio?.channels ?? 0) === 0 || track.audio.channels <= 6)) {
          selectedAudio = track.trackId;
          demuxer.selectTrack('audio', selectedAudio);
          demuxer.selectTrack('audio', selectedAudio);
        }
      },
      onTrackRemoved(track) {
        tracks.delete(track.trackId);
        // A seek reposition removes and re-announces the transient catalogue;
        // it does not release the transaction's selected A/V identities.
      },
      onPlaybackAccessUnitView(unit) {
        if ((unit.codec === 'hevc' || unit.codec === 'aac-latm') &&
            probeUnits.length < 64) {
          probeUnits.push(`${unit.trackId}:${unit.ptsValue}/${unit.ptsTimescale}:` +
            `${unit.codec}:${unit.randomAccess}:${unit.restartOffset}`);
        }
        locator?.observeAccessUnit(unit);
      },
      onMseVideoSplice(splice) {
        outputOrder.push('video-splice');
        offsets.video = BigInt(splice.timestampOffsetUs ?? 0n);
        splices.video.push(splice);
      },
      onMseAudioSplice(splice) {
        outputOrder.push('audio-splice');
        offsets.audio = BigInt(splice.timestampOffsetUs ?? 0n);
        splices.audio.push(splice);
      },
      onMseVideoRecovery(event) { videoRecoveryEvents.push(event); },
      onMseInit(init) {
        outputOrder.push(`init:${init.type}`);
        if (init.type in timescales) timescales[init.type] = initTimescale(init.data);
      },
      onMseSegment(segment) {
        if (!(segment.type in ranges)) return;
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
    demuxer.startIndex(false);
    demuxer.setIndexDuration(presentationEndUs);
    const source = {
      size: sourceSize,
      async read(offset, length) {
        requests.push({offset, length});
        return readRange(offset, length);
      },
    };
    locator = createMseRecordedWindowLocator({
      source,
      presentationStartUs,
      presentationEndUs,
      demuxer,
      queues,
      selectedAudioTrack: () => selectedAudio,
      preferredVideoTrack: () => selectedVideoTrack,
      rainfallVideoTrack: () => [...tracks.values()].find(track =>
        track.kind === 'video' && track.trackId !== selectedVideo &&
        sameLayerGroup(selectedVideoTrack, track)) ?? null,
      activateVideoTrack: async (_mode, video) => {
        if (video.trackId === selectedVideo) return;
        const track = tracks.get(video.trackId);
        if (!track) return;
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
    });
    try {
      let result;
      try {
        demuxer.beginMseRecordedSeek();
        result = await locator.locate({
          targetTimeSeconds,
          readBudgetBytes: BigInt(MSE_RECORDED_READ_BUDGET_BYTES),
          signal: new AbortController().signal,
          transition() {},
        });
        demuxer.finishMseRecordedSeek(BigInt(Math.round(targetTimeSeconds * 1000000)));
        if (callbackError) throw callbackError;
      } catch (error) {
        demuxer.cancelMseRecordedSeek();
        error.message += ` diagnostics=${JSON.stringify(error.diagnostics,
          (_, value) => typeof value === 'bigint' ? value.toString() : value)}`;
        error.message += ` target=${targetTimeSeconds}s requests=` + requests.map(request =>
          `${request.offset}+${request.length}`).join(',') + ` tracks=${JSON.stringify(
            [...tracks.values()].filter(track => track.kind === 'video').map(track => ({
              trackId: String(track.trackId), packetId: String(track.packetId),
              selectionLevel: selectionLevel(track),
            })))} ranges=${JSON.stringify(ranges)} recovery=${JSON.stringify(videoRecoveryEvents,
              (_, value) => typeof value === 'bigint' ? value.toString() : value)} ` +
          `declaredRanges=${JSON.stringify(declaredRanges)} units=${probeUnits.join(',')}`;
        throw error;
      }
      const requested = requests.reduce((sum, request) => sum + request.length, 0n);
      for (const type of ['video', 'audio']) {
        const spliceIndex = outputOrder.indexOf(`${type}-splice`);
        const initIndex = outputOrder.indexOf(`init:${type}`);
        assert.ok(spliceIndex >= 0 && initIndex > spliceIndex,
          `seek ${targetTimeSeconds}s emitted ${type} init before its formal splice: ` +
          outputOrder.join(','));
      }
      assert.equal(requested, result.bytesRead);
      assert.ok(requested <= BigInt(MSE_RECORDED_READ_BUDGET_BYTES),
        `seek ${targetTimeSeconds}s exceeded the 16 MiB budget`);
      assert.ok(result.video.startTimeSeconds <= result.audio.startTimeSeconds + 0.05,
        `seek ${targetTimeSeconds}s selected future video for an earlier AAC window`);
      const targetRanges = Object.fromEntries(Object.entries(ranges).map(([type, items]) => [
        type,
        items.filter(range => range.start <= targetTimeSeconds + 0.000002 &&
          range.end >= targetTimeSeconds),
      ]));
      assert.ok(targetRanges.video.length > 0 && targetRanges.audio.length > 0,
        `seek ${targetTimeSeconds}s did not retain exact per-track target coverage: ` +
        JSON.stringify(ranges));
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
          const sourceTargetUs = presentationStartUs +
            BigInt(Math.round(targetTimeSeconds * 1000000));
          concealed = damageStartUs <= sourceTargetUs &&
            sourceTargetUs < BigInt(event.presentationTimeUs);
          damageStartUs = null;
        }
      }
      if (concealed) {
        assert.ok(Math.abs(targetRanges.video[0].start - targetTimeSeconds) <= 0.000002,
          `concealed video did not begin at exact target ${targetTimeSeconds}s`);
      }
      results.push({
        targetTimeSeconds,
        selectedAudioPacketId: tracks.get(selectedAudio)?.packetId ?? null,
        videoMode: result.videoMode,
        videoTimeSeconds: result.video.startTimeSeconds,
        restartOffset: String(result.video.restartOffset ?? result.audio.restartOffset),
        nextOffset: result.nextOffset.toString(),
        bytesRead: result.bytesRead.toString(),
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
