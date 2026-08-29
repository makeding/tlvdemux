import assert from 'node:assert/strict';

import {
  MSE_SEEK_NO_COMMON_AV,
  MSE_SEEK_READ_BUDGET_BYTES,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs';

const MiB = 1024 * 1024;

function queue(ranges = []) {
  return {
    ranges,
    bufferedRanges() { return this.ranges; },
    trimBefore() {},
    waitFlowControlled() { return Promise.resolve(); },
    waitStable() { return Promise.resolve(); },
  };
}

function fixture({
  landingRanges,
  noRap = false,
  abortOnRead = false,
  cachedEstimateOffset = null,
} = {}) {
  const media = {currentTime: 50};
  const video = queue();
  const audio = queue();
  const queues = new Map([['video', video], ['audio', audio]]);
  const controller = new AbortController();
  const requests = [];
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      requests.push({offset, length});
      if (abortOnRead) controller.abort();
      return new Uint8Array(Number(length));
    },
  };
  let position = 0n;
  let landingPushes = 0;
  const indexCalls = [];
  let session;
  const track = {kind: 'video', codec: 'hevc', trackId: 1, priority: 0};
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  const demuxer = {
    async setMseOutputEnabled(enabled) { this.output = enabled; return true; },
    async setIndexDuration(value) { indexCalls.push(['duration', value]); return true; },
    async estimateOffset(value) { indexCalls.push(['target', value]); return 16n * BigInt(MiB); },
    async setMseTimestampOffset(value) { indexCalls.push(['offset', value]); },
    async reposition(offset) { position = offset; return true; },
    async push(data) {
      if (session.phase === 'head') {
        session.observeTrack(track);
        session.observeTrack(audioTrack);
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 0n, ptsTimescale: 1000000,
          randomAccess: true, restartOffset: 0n,
        });
      } else if (session.phase === 'probe') {
        if (!noRap) {
          session.observeAccessUnit({
            codec: 'hevc', trackId: 1, ptsValue: 51000000n, ptsTimescale: 1000000,
            randomAccess: true, restartOffset: position,
          });
        }
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: noRap ? 0n : 53100000n, ptsTimescale: 1000000,
          randomAccess: false, restartOffset: position,
        });
      } else if (session.phase === 'landing') {
        landingPushes += 1;
        const next = landingRanges?.(landingPushes) ?? (landingPushes === 1
          ? {video: [{start: 48, end: 49.5}], audio: [{start: 48.1, end: 49.4}]}
          : {video: [{start: 48, end: 51}], audio: [{start: 48.1, end: 51}]});
        video.ranges = next.video;
        audio.ranges = next.audio;
      }
      position += BigInt(data.byteLength);
      return true;
    },
  };
  const flowControl = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: 50,
  });
  session = createMseRecordedSeekSession({
    targetTimeSeconds: 50,
    source,
    durationUs: 100000000n,
    presentationStartUs: 2000000n,
    presentationEndUs: 102000000n,
    demuxer,
    media,
    queues,
    flowControl,
    estimateOffset: cachedEstimateOffset,
    signal: controller.signal,
    headReady: () => session?.phase === 'head' && requests.length > 0,
    chunkBytes: MiB,
  });
  return {session, requests, controller, flowControl, indexCalls};
}

{
  const {session, requests, flowControl, indexCalls} = fixture();
  const result = await session.run();
  assert.equal(result.rapPresentationTimeUs, 51000000n,
    'seek did not choose the closest RAP at or before the target');
  assert.equal(flowControl.entryCovered(), true,
    'seek did not wait for common A/V to cover the target');
  assert.ok(result.bytesRead <= BigInt(MSE_SEEK_READ_BUDGET_BYTES));
  assert.equal(requests.reduce((sum, request) => sum + request.length, 0n), result.bytesRead,
    'overlapping probe and landing data was fetched twice');
  assert.equal(result.sourceTargetUs, 52000000n,
    'public seek target was not mapped through the union presentation start');
  assert.deepEqual(indexCalls.slice(0, 3), [
    ['offset', -2000000n], ['duration', 102000000n], ['target', 52000000n],
  ], 'seek estimate and MSE output did not share the union presentation range');
}

{
  const cachedCalls = [];
  const {session, indexCalls} = fixture({
    cachedEstimateOffset(targetUs, sourceSize) {
      cachedCalls.push({targetUs, sourceSize});
      return 16n * BigInt(MiB);
    },
  });
  await session.run();
  assert.deepEqual(cachedCalls, [{targetUs: 52_000_000n, sourceSize: 32n * BigInt(MiB)}],
    'recorded candidate did not reuse the active recording index estimate');
  assert.ok(!indexCalls.some(([kind]) => kind === 'target'),
    'recorded candidate rebuilt an estimate despite a cached active index result');
}

for (const landingRanges of [
  () => ({video: [{start: 51, end: 53}], audio: [{start: 51, end: 53}]}),
  () => ({video: [{start: 48, end: 51}], audio: [{start: 51.1, end: 53}]}),
]) {
  const {session} = fixture({landingRanges});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.name !== 'MseStartupBufferError');
}

{
  const {session, requests} = fixture({noRap: true});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted');
  const requested = requests.reduce((sum, request) => sum + request.length, 0n);
  assert.equal(requested, BigInt(MSE_SEEK_READ_BUDGET_BYTES),
    'head and every probe attempt did not share the exact 16 MiB budget');
}

{
  const {session, requests} = fixture({abortOnRead: true});
  await assert.rejects(session.run(), error => error.name === 'AbortError');
  assert.equal(requests.length, 1, 'a superseded seek issued another source request');
}

{
  const media = {currentTime: 50};
  const audio = queue();
  const queues = new Map([['audio', audio]]);
  const requests = [];
  let position = 0n;
  let session;
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      requests.push({offset, length});
      return new Uint8Array(Number(length));
    },
  };
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  const demuxer = {
    async setMseOutputEnabled() { return true; },
    async setIndexDuration() { return true; },
    async estimateOffset() { return 16n * BigInt(MiB); },
    async setMseTimestampOffset() {},
    async reposition(offset) { position = offset; return true; },
    async push(data) {
      session.observeTrack(audioTrack);
      if (session.phase === 'head') {
        session.observeAccessUnit({
          codec: 'aac-latm', trackId: 2, ptsValue: 0n, ptsTimescale: 1_000_000,
          randomAccess: false, restartOffset: 0n,
        });
      } else if (session.phase === 'probe') {
        for (const ptsValue of [51_900_000n, 52_100_000n]) {
          session.observeAccessUnit({
            codec: 'aac-latm', trackId: 2, ptsValue, ptsTimescale: 1_000_000,
            randomAccess: false, restartOffset: position,
          });
        }
      } else if (session.phase === 'landing') {
        audio.ranges = [{start: 49.9, end: 52}];
      }
      position += BigInt(data.byteLength);
      return true;
    },
  };
  session = createMseRecordedSeekSession({
    targetTimeSeconds: 50,
    source,
    durationUs: 100_000_000n,
    presentationStartUs: 2_000_000n,
    presentationEndUs: 102_000_000n,
    demuxer,
    media,
    queues,
    requiredTracks: ['audio'],
    headReady: () => requests.length > 0,
    chunkBytes: MiB,
  });
  const result = await session.run();
  assert.equal(result.rapPresentationTimeUs, 51_900_000n,
    'audio-only recorded entry waited for a video RAP');
  assert.ok(result.bytesRead <= BigInt(MSE_SEEK_READ_BUDGET_BYTES));
  assert.equal(requests.reduce((sum, request) => sum + request.length, 0n), result.bytesRead,
    'audio-only recorded entry exceeded its shared source-read accounting');
}

console.log('MSE recorded seek tests passed');
