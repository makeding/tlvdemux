import assert from 'node:assert/strict';

import {
  MSE_SEEK_NO_COMMON_AV,
  MSE_SEEK_READ_BUDGET_BYTES,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs';

const MiB = 1024 * 1024;

const queue = (ranges = []) => ({
  ranges,
  bufferedRanges() { return this.ranges; },
  committedRanges() { return this.ranges; },
  trimBefore() {},
  waitFlowControlled() { return Promise.resolve(); },
  waitStable() { return Promise.resolve(); },
});

function fixture({
  landing = 'exact', gapSeconds = 0.04, budget = 16 * MiB,
  targetTimeSeconds = 50, bootstrapRapUs = 0n, planRap = true,
  reusedIndex = false, planRaps = null, damageEpisode = null,
  abortAfterReads = null, endAfterReads = null, failAfterReads = null,
} = {}) {
  const media = {currentTime: targetTimeSeconds};
  const video = queue();
  const audio = queue();
  const queues = new Map([['video', video], ['audio', audio]]);
  const requests = [];
  const operations = [];
  const lifecycle = [];
  let flushAudioCalls = 0;
  let flushLandingCalls = 0;
  let readCalls = 0;
  let aborted = false;
  let position = 0n;
  let session;
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      readCalls += 1;
      requests.push({offset, length, phase: session?.phase});
      if (abortAfterReads === readCalls) aborted = true;
      if (failAfterReads === readCalls) throw new Error('fixture source failure');
      if (endAfterReads === readCalls) return new Uint8Array();
      return new Uint8Array(Number(length));
    },
  };
  const videoTrack = {kind: 'video', codec: 'hevc', trackId: 1};
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  const demuxer = {
    async beginMseRecordedSeek() { lifecycle.push(['begin']); },
    async finishMseRecordedSeek(target) { lifecycle.push(['finish', target, session.phase]); },
    async cancelMseRecordedSeek() { lifecycle.push(['cancel', session.phase]); },
    async flushMseRecordedSeekLanding() { flushLandingCalls += 1; },
    async flushMseRecordedSeekAudio() { flushAudioCalls += 1; },
    async setMseOutputEnabled() {},
    async setMseTimestampOffset() {},
    async setIndexDuration() { return true; },
    async estimateOffset() { return 16n * BigInt(MiB); },
    async previousSync() {
      return reusedIndex ? {
        presentationTimeUs: 51_000_000n,
        signallingOffset: 12n * BigInt(MiB),
        randomAccessOffset: 12n * BigInt(MiB) + 1024n,
        videoTrackId: 1,
      } : null;
    },
    async reposition(offset) { operations.push([session.phase, offset]); position = offset; },
    async setMseRecordedSeekConcealmentTarget() {},
    async getMseRecordedSeekLandingEvidence() {
      return landing === 'held-frame'
        ? {landingMode: 'held-frame', heldFrameTimeUs: 51_500_000n, recoveryTimeUs: 53_000_000n}
        : {landingMode: 'exact'};
    },
    async push(data) {
      session.observeTrack(videoTrack);
      session.observeTrack(audioTrack);
      if (session.phase === 'bootstrap') {
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: bootstrapRapUs, ptsTimescale: 1_000_000,
          randomAccess: true, restartOffset: 0n,
        });
      } else if (session.phase === 'backward-plan' && planRap) {
        if (damageEpisode) session.observeDamage({
          severity: 'severe', videoTrackId: 1,
          startTimeUs: damageEpisode.startUs,
          recoveryTimeUs: damageEpisode.endUs,
        });
        for (const [index, ptsValue] of (planRaps ?? [51_000_000n]).entries()) {
          session.observeAccessUnit({
            codec: 'hevc', trackId: 1, ptsValue, ptsTimescale: 1_000_000,
            randomAccess: true, restartOffset: position + BigInt(index * 4096),
          });
        }
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 53_000_000n, ptsTimescale: 1_000_000,
          randomAccess: false, restartOffset: position,
        });
      } else if (session.phase === 'single-landing') {
        video.ranges = landing === 'natural-start'
          ? [{start: 0.533873, end: 3}]
          : [{start: targetTimeSeconds - 1, end: targetTimeSeconds + 3}];
        audio.ranges = landing === 'natural-start'
          ? [{start: 0, end: 3}]
          : landing === 'exact'
          ? [{start: targetTimeSeconds - 1, end: targetTimeSeconds + 3}]
          : [{start: targetTimeSeconds - 1, end: targetTimeSeconds - gapSeconds}];
      }
      position += BigInt(data.byteLength);
      return true;
    },
  };
  const flowControl = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: targetTimeSeconds,
    allowNaturalStart: targetTimeSeconds === 0,
  });
  session = createMseRecordedSeekSession({
    targetTimeSeconds,
    source,
    durationUs: 100_000_000n,
    presentationStartUs: 2_000_000n,
    presentationEndUs: 102_000_000n,
    demuxer,
    media,
    queues,
    flowControl,
    headReady: () => session?.phase === 'bootstrap',
    chunkBytes: MiB,
    readBudgetBytes: budget,
    landingReserveBytes: 7 * MiB,
    signal: {get aborted() { return aborted; }},
    initialTracks: reusedIndex ? [videoTrack, audioTrack] : [],
    timelineEstablished: reusedIndex,
  });
  return {
    session, media, requests, operations, lifecycle, flowControl,
    get flushAudioCalls() { return flushAudioCalls; },
    get flushLandingCalls() { return flushLandingCalls; },
  };
}

{
  const {session, media, operations} = fixture({
    landing: 'natural-start', targetTimeSeconds: 0, bootstrapRapUs: 2_000_000n,
  });
  const result = await session.run();
  assert.equal(result.landingMode, 'natural-start');
  assert.equal(result.requestedTimeSeconds, 0);
  assert.equal(media.currentTime, 0,
    'natural Recorded start replaced media time zero with the first video RAP');
  assert.equal(operations.filter(([phase]) => phase === 'backward-plan').length, 0,
    'recording start wasted its landing budget on a backward plan');
}

{
  const {session, requests, operations} = fixture({reusedIndex: true});
  const result = await session.run();
  assert.equal(requests.some(request => request.offset === 0n), false,
    'reused indexed demuxer reread the file head');
  assert.equal(result.restartOffset, 12n * BigInt(MiB),
    'reused demuxer did not land from RecordingIndex.previousSync()');
  assert.equal(operations.filter(([phase]) => phase === 'backward-plan').length, 0,
    'reused RecordingIndex point was replaced with a sparse probe');
}

{
  const {session, operations} = fixture({planRap: false, bootstrapRapUs: 60_000_000n});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'no-rap' &&
      error.diagnostics.phase === 'backward-plan');
  const planOffsets = operations.filter(([phase]) => phase === 'backward-plan')
    .map(([, offset]) => offset);
  assert.ok(planOffsets.length >= 1 && planOffsets.every((offset, index) =>
    index === 0 || offset < planOffsets[index - 1]),
  'an empty planned window returned toward the duration estimate instead of expanding backward');
}

{
  const seek = fixture();
  const {session, media, requests, operations, lifecycle} = seek;
  const result = await session.run();
  assert.equal(result.landingMode, 'exact');
  assert.equal(result.requestedTimeSeconds, 50);
  assert.equal(result.sourceTargetUs, 52_000_000n);
  assert.equal(media.currentTime, 50, 'formal seek rewrote the requested media clock');
  assert.equal(operations.filter(([phase]) => phase === 'single-landing').length, 1,
    'formal landing repositioned more than once');
  assert.ok(operations.some(([phase]) => phase === 'backward-plan'),
    'seek did not form a bounded backward plan');
  assert.ok(result.bytesRead <= BigInt(MSE_SEEK_READ_BUDGET_BYTES));
  const planningBytes = requests.filter(request => request.phase !== 'single-landing')
    .reduce((total, request) => total + request.length, 0n);
  assert.ok(planningBytes <= 9n * BigInt(MiB),
    'bootstrap/backward planning invaded the reserved 7 MiB landing budget');
  assert.equal(requests.reduce((total, request) => total + request.length, 0n), result.bytesRead,
    'the single seek ledger did not account for every source read');
  assert.equal(requests.filter(request => request.phase === 'single-landing').length, 0,
    'formal landing reread the byte window already cached during planning');
  assert.equal(seek.flushAudioCalls, 1,
    'a short selected AAC prefix was not sealed after its landing push');
  assert.deepEqual(lifecycle, [['begin'], ['finish', 50_000_000n, 'committing']]);
}

{
  const {session, media} = fixture({
    planRaps: [47_000_000n, 51_000_000n],
    damageEpisode: {startUs: 50_000_000n, endUs: 52_000_000n},
  });
  const result = await session.run();
  assert.equal(result.rapPresentationTimeUs, 47_000_000n,
    'severe damage selected a RAP from inside the damage episode');
  assert.equal(result.requestedTimeSeconds, 50);
  assert.equal(media.currentTime, 50,
    'damage fallback replaced the requested target with the earlier RAP');
}

{
  const {session, media, flowControl} = fixture({landing: 'held-frame'});
  const result = await session.run();
  assert.equal(result.landingMode, 'held-frame');
  assert.equal(result.heldFrameTimeSeconds, 49.5);
  assert.equal(result.recoveryTimeSeconds, 51);
  assert.ok(flowControl.heldFrameEntryRange(),
    'a complete pre-target video frame plus short AAC tail was not recognized');
  assert.equal(media.currentTime, 50,
    'held-frame commit replaced the requested media clock with the frame time');
}

{
  const {session, media} = fixture({landing: 'natural-tail'});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted');
  assert.equal(media.currentTime, 50);
}

{
  const {session} = fixture({landing: 'held-frame', gapSeconds: 0.251});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted' &&
      error.diagnostics.phase === 'single-landing');
}

{
  const {session, requests} = fixture({landing: 'held-frame', budget: 9 * MiB});
  await session.run();
  assert.ok(requests.reduce((total, request) => total + request.length, 0n) <= 3n * BigInt(MiB),
    'seek read after completing a held-frame landing');
}

{
  const {session, lifecycle} = fixture({abortAfterReads: 2});
  await assert.rejects(session.run(), error => error.name === 'AbortError');
  assert.deepEqual(lifecycle, [['begin'], ['cancel', 'backward-plan']],
    'a superseded generation leaked seek state or committed its target');
}

{
  const ended = fixture({endAfterReads: 2});
  await assert.rejects(ended.session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'source-ended' &&
      error.diagnostics.phase === 'backward-plan');
  assert.deepEqual(ended.lifecycle, [['begin'], ['cancel', 'backward-plan']]);
}

{
  const failed = fixture({failAfterReads: 2});
  await assert.rejects(failed.session.run(), error =>
    error.message.includes('fixture source failure') &&
      error.diagnostics.phase === 'backward-plan');
  assert.deepEqual(failed.lifecycle, [['begin'], ['cancel', 'backward-plan']]);
}

console.log('MSE recorded seek tests passed');
