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
    _ranges: ranges,
    get ranges() { return this._ranges; },
    set ranges(value) { this._ranges = value; },
    bufferedRanges() { return this._ranges; },
    committedRanges() { return this._ranges; },
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
  estimatedOffset = 16n * BigInt(MiB),
  probeRapUs = 51_000_000n,
  probeSilentBeforeOffset = null,
  coverOnCancel = false,
  headTimelineOnRead = 1,
} = {}) {
  const media = {currentTime: 50};
  const video = queue();
  const audio = queue();
  const queues = new Map([['video', video], ['audio', audio]]);
  const controller = new AbortController();
  const requests = [];
  const operations = [];
  const seekLifecycle = [];
  const concealmentTargets = [];
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      requests.push({offset, length});
      if (abortOnRead) controller.abort();
      return new Uint8Array(Number(length));
    },
  };
  let position = 0n;
  let headPushes = 0;
  let landingPushes = 0;
  const indexCalls = [];
  let session;
  const track = {kind: 'video', codec: 'hevc', trackId: 1, priority: 0};
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  const demuxer = {
    async beginMseRecordedSeek() { seekLifecycle.push(['begin']); },
    async finishMseRecordedSeek(target) {
      seekLifecycle.push(['finish', target, session?.phase]);
    },
    async cancelMseRecordedSeek() {
      seekLifecycle.push(['cancel', session?.phase]);
      if (coverOnCancel) {
        video.ranges = [{start: 49, end: 51}];
        audio.ranges = [{start: 49, end: 51}];
      }
    },
    async setMseOutputEnabled(enabled) { this.output = enabled; return true; },
    async setIndexDuration(value) { indexCalls.push(['duration', value]); return true; },
    async estimateOffset(value) { indexCalls.push(['target', value]); return estimatedOffset; },
    async setMseTimestampOffset(value) { indexCalls.push(['offset', value]); },
    async reposition(offset) {
      operations.push(['reposition', session?.phase, offset]);
      position = offset;
      return true;
    },
    async setMseRecordedSeekConcealmentTarget(target) {
      operations.push(['concealment-target', session?.phase, target]);
      concealmentTargets.push(target);
    },
    async push(data) {
      if (session.phase === 'head') {
        headPushes += 1;
        session.observeTrack(track);
        session.observeTrack(audioTrack);
        if (headPushes >= headTimelineOnRead) {
          session.observeAccessUnit({
            codec: 'hevc', trackId: 1, ptsValue: 0n, ptsTimescale: 1000000,
            randomAccess: true, restartOffset: 0n,
          });
        }
      } else if (session.phase === 'probe') {
        if (probeSilentBeforeOffset !== null && position < probeSilentBeforeOffset) {
          position += BigInt(data.byteLength);
          return true;
        }
        if (!noRap) {
          session.observeAccessUnit({
            codec: 'hevc', trackId: 1, ptsValue: probeRapUs, ptsTimescale: 1000000,
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
  return {
    session, requests, controller, flowControl, indexCalls, media,
    operations, concealmentTargets, seekLifecycle,
  };
}

{
  const {session, requests} = fixture({headTimelineOnRead: 2});
  await session.run();
  assert.deepEqual(requests.slice(0, 2).map(request => request.offset), [0n, BigInt(MiB)],
    'recorded seek left the head before establishing the normalization timeline');
  assert.notEqual(requests[2].offset, 2n * BigInt(MiB),
    'recorded seek began a sequential scan instead of its bounded target probe');
}

{
  const {session, requests} = fixture({
    probeSilentBeforeOffset: 20n * BigInt(MiB),
  });
  const result = await session.run();
  assert.equal(result.restartOffset, 20n * BigInt(MiB),
    'recorded seek did not cross media-free estimated windows to the real RAP');
  assert.deepEqual(requests.slice(1, 7).map(request => request.offset),
    [15n, 16n, 17n, 18n, 19n, 20n].map(value => value * BigInt(MiB)),
  'recorded seek searched backward before exhausting a bounded forward probe span');
}

{
  const {session} = fixture({
    landingRanges: () => ({video: [], audio: []}),
    coverOnCancel: true,
  });
  await assert.rejects(session.run(), error => {
    assert.equal(error.diagnostics.phase, 'landing');
    assert.equal(error.diagnostics.entryCovered, false);
    assert.equal(error.diagnostics.entryRange, null);
    assert.equal(error.diagnostics.flowEntryTimeSeconds, 50);
    assert.deepEqual(error.diagnostics.flowRequiredTracks, ['video', 'audio']);
    assert.deepEqual(error.diagnostics.tracks.video.committed, [],
      'failure diagnostics were captured after cancellation changed queue state');
    return error.code === MSE_SEEK_NO_COMMON_AV;
  });
}

{
  const {
    session, requests, flowControl, indexCalls, media,
    operations, concealmentTargets, seekLifecycle,
  } = fixture();
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
  assert.deepEqual(concealmentTargets, [52_000_000n, null],
    'formal landing did not arm and clear the original source target exactly once');
  assert.deepEqual(operations.filter(([name, phase]) =>
    name === 'reposition' && phase === 'landing').length, 1,
  'formal landing performed a second reposition');
  assert.ok(operations.findIndex(([name]) => name === 'concealment-target') >
    operations.findIndex(([name, phase]) => name === 'reposition' && phase === 'landing'),
  'concealment target was armed before the final landing reposition reset');
  assert.equal(media.currentTime, 50,
    'recorded seek changed the user-requested MediaElement time');
  assert.deepEqual(seekLifecycle, [['begin'], ['finish', 50_000_000n, 'committing']],
    'recorded seek did not fence the complete transaction at the exact media clock');
  assert.equal(session.phase, 'complete',
    'recorded seek became complete before its native fence committed');
}

{
  const {session, media} = fixture({
    estimatedOffset: 0n,
    probeRapUs: 51_900_000n,
  });
  const result = await session.run();
  assert.equal(result.restartOffset, 0n,
    'a near-start seek did not accept the earliest available RAP');
  assert.equal(media.currentTime, 50,
    'the near-start RAP exception changed the requested MediaElement time');
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

{
  const media = {currentTime: 50};
  const video = queue();
  const audio = queue();
  const queues = new Map([['video', video], ['audio', audio]]);
  const requests = [];
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      requests.push({offset, length});
      return new Uint8Array(Number(length));
    },
  };
  const track = {kind: 'video', codec: 'hevc', trackId: 1};
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  let position = 0n;
  const repositionOffsets = [];
  let session;
  const demuxer = {
    async beginMseRecordedSeek() {},
    async finishMseRecordedSeek() {},
    async cancelMseRecordedSeek() {},
    async setMseOutputEnabled() { return true; },
    async setIndexDuration() { return true; },
    async estimateOffset() { return 24n * BigInt(MiB); },
    async setMseTimestampOffset() {},
    async reposition(offset) {
      repositionOffsets.push(offset);
      assert.ok(repositionOffsets.length <= 16,
        `bounded probe fixture reposition looped: ${repositionOffsets.join(',')}`);
      position = offset;
      return true;
    },
    async setMseRecordedSeekConcealmentTarget() {},
    async push(data) {
      if (session.phase === 'head') {
        session.observeTrack(track);
        session.observeTrack(audioTrack);
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 0n, ptsTimescale: 1_000_000,
          randomAccess: true, restartOffset: 0n,
        });
      } else if (session.phase === 'probe' && position <= 18n * BigInt(MiB)) {
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 49_000_000n, ptsTimescale: 1_000_000,
          randomAccess: true, restartOffset: position,
        });
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 50_100_000n, ptsTimescale: 1_000_000,
          randomAccess: false, restartOffset: position,
        });
      } else if (session.phase === 'probe' && position < 22n * BigInt(MiB)) {
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 49_900_000n, ptsTimescale: 1_000_000,
          randomAccess: true, restartOffset: position,
        });
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 50_100_000n, ptsTimescale: 1_000_000,
          randomAccess: false, restartOffset: position,
        });
      } else if (session.phase === 'probe') {
        // More than the old AU-history limit must not evict the earlier
        // timeline anchor used to interpolate the next bounded probe.
        for (let index = 0; index < 513; index += 1) {
          session.observeAccessUnit({
            codec: 'hevc', trackId: 1,
            ptsValue: 60_000_000n + BigInt(index), ptsTimescale: 1_000_000,
            randomAccess: false, restartOffset: position,
          });
        }
      } else if (session.phase === 'landing') {
        video.ranges = [{start: 49, end: 51}];
        audio.ranges = [{start: 49, end: 51}];
      }
      position += BigInt(data.byteLength);
      return true;
    },
  };
  session = createMseRecordedSeekSession({
    targetTimeSeconds: 50,
    source,
    durationUs: 100_000_000n,
    demuxer,
    media,
    queues,
    headReady: () => session?.phase === 'head' && requests.length > 0,
    chunkBytes: MiB,
  });
  const result = await session.run();
  assert.equal(result.rapPresentationTimeUs, 49_900_000n);
  assert.equal(requests[1].offset, 23n * BigInt(MiB));
  assert.ok(requests[2].offset > 18n * BigInt(MiB) &&
    requests[2].offset < 22n * BigInt(MiB),
  'an aged-out timeline anchor made the probe scan an unrelated earlier interval');
  assert.equal(media.currentTime, 50,
    'bounded backward probing changed the requested MediaElement time');
}

for (const landingRanges of [
  () => ({video: [{start: 51, end: 53}], audio: [{start: 51, end: 53}]}),
  () => ({video: [{start: 48, end: 51}], audio: [{start: 51.1, end: 53}]}),
]) {
  const {session, concealmentTargets, seekLifecycle} = fixture({landingRanges});
  await assert.rejects(session.run(), error => {
    assert.equal(error.diagnostics.targetTimeSeconds, 50);
    assert.equal(error.diagnostics.budgetBytes, String(MSE_SEEK_READ_BUDGET_BYTES));
    assert.deepEqual(error.diagnostics.tracks.video.buffered, landingRanges().video);
    assert.match(error.message, /Diagnostics:.*targetTimeSeconds/);
    return error.code === MSE_SEEK_NO_COMMON_AV && error.name !== 'MseStartupBufferError';
  });
  assert.deepEqual(concealmentTargets, [52_000_000n, null],
    'a failed landing retained its one-shot concealment target');
  assert.deepEqual(seekLifecycle, [['begin'], ['cancel', 'landing']],
    'a failed landing committed or retained its recorded-seek fence');
  assert.equal(session.phase, 'cancelled',
    'a failed landing remained eligible to start playback');
}

{
  const {session, media} = fixture({
    landingRanges(push) {
      return push === 1
        ? {video: [{start: 51, end: 53}], audio: [{start: 49, end: 53}]}
        : {video: [{start: 50, end: 53}], audio: [{start: 49, end: 53}]};
    },
  });
  const result = await session.run();
  assert.equal(result.sourceTargetUs, 52_000_000n,
    'later-only landing did not complete after target concealment appeared');
  assert.equal(media.currentTime, 50,
    'concealed later-only landing replaced the requested time');
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
  const {session, requests, seekLifecycle} = fixture({abortOnRead: true});
  await assert.rejects(session.run(), error => error.name === 'AbortError');
  assert.equal(requests.length, 1, 'a superseded seek issued another source request');
  assert.deepEqual(seekLifecycle, [['begin'], ['cancel', 'head']],
    'a superseded seek did not release its fence without committing');
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
    async beginMseRecordedSeek() {},
    async finishMseRecordedSeek() {},
    async cancelMseRecordedSeek() {},
    async setMseOutputEnabled() { return true; },
    async setIndexDuration() { return true; },
    async estimateOffset() { return 16n * BigInt(MiB); },
    async setMseTimestampOffset() {},
    async setMseRecordedSeekConcealmentTarget(target) {
      assert.equal(target, null, 'audio-only seek armed video concealment');
    },
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
