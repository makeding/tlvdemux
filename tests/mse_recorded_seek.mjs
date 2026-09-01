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
  maxBudget = 64 * MiB, sourceSize = 32 * MiB,
  targetTimeSeconds = 50, bootstrapRapUs = 0n, planRap = true,
  reusedIndex = false, estimateBytes = 16 * MiB, indexedRestartBytes = 12 * MiB,
  videoWidth = 3840, videoHeight = 2160,
  landingAfterPushes = 1, planRaps = null, damageEpisode = null,
  planRapsByPush = null, planningClocksByPush = null,
  planRapAfterPlanningBytes = null,
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
  let landingPushes = 0;
  let backwardPushes = 0;
  const source = {
    size: BigInt(sourceSize),
    async read(offset, length) {
      readCalls += 1;
      requests.push({offset, length, phase: session?.phase});
      if (abortAfterReads === readCalls) aborted = true;
      if (failAfterReads === readCalls) throw new Error('fixture source failure');
      if (endAfterReads === readCalls) return new Uint8Array();
      return new Uint8Array(Number(length));
    },
  };
  const videoTrack = {
    kind: 'video', codec: 'hevc', trackId: 1,
    video: {width: videoWidth, height: videoHeight},
  };
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
    async estimateOffset() { return BigInt(estimateBytes); },
    async previousSync() {
      return reusedIndex ? {
        presentationTimeUs: 51_000_000n,
        signallingOffset: BigInt(indexedRestartBytes),
        randomAccessOffset: BigInt(indexedRestartBytes) + 1024n,
        videoTrackId: 1,
      } : null;
    },
    async reposition(offset) { operations.push([session.phase, offset]); position = offset; },
    async broadcastClock() {
      const clock = planningClocksByPush?.[backwardPushes - 1];
      return clock ? {
        mediaTimeValue: clock.ptsUs,
        mediaTimeTimescale: 1_000_000,
        inputOffset: clock.offset ?? position,
      } : null;
    },
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
        backwardPushes += 1;
        if (damageEpisode) session.observeDamage({
          severity: 'severe', videoTrackId: 1,
          startTimeUs: damageEpisode.startUs,
          recoveryTimeUs: damageEpisode.endUs,
        });
        const observedRaps = planRapAfterPlanningBytes === null
          ? planRapsByPush?.[backwardPushes - 1] ??
            (planRapsByPush ? [] : planRaps ?? [51_000_000n])
          : session.bytesRead >= BigInt(planRapAfterPlanningBytes)
            ? [49_000_000n] : backwardPushes === 1 ? [53_000_000n] : [];
        for (const [index, ptsValue] of observedRaps.entries()) {
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
        landingPushes += 1;
        if (landingPushes < landingAfterPushes) {
          position += BigInt(data.byteLength);
          return true;
        }
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
    maxReadBudgetBytes: maxBudget,
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
  const seek = fixture({
    planRapsByPush: [[], [], [], [], [49_000_000n]],
    planningClocksByPush: [
      {ptsUs: 53_000_000n, offset: 16n * BigInt(MiB)},
      {ptsUs: 48_000_000n, offset: 13n * BigInt(MiB)},
      {ptsUs: 49_000_000n, offset: 14n * BigInt(MiB)},
      {ptsUs: 50_000_000n, offset: 15n * BigInt(MiB)},
    ],
  });
  const result = await seek.session.run();
  const planRequests = seek.requests.filter(request => request.phase === 'backward-plan');
  assert.equal(result.rapPresentationTimeUs, 49_000_000n);
  assert.ok(planRequests.slice(2).some((request, index, requests) => index > 0 &&
    request.offset === requests[index - 1].offset + requests[index - 1].length),
  'the projected candidate Range was not expanded contiguously');
  const planningBytes = seek.requests.filter(request => request.phase !== 'single-landing')
    .reduce((total, request) => total + request.length, 0n);
  assert.ok(planningBytes <= 9n * BigInt(MiB),
    'coarse location and candidate expansion invaded the landing reserve');
}

{
  const seek = fixture({
    sourceSize: 128 * MiB,
    estimateBytes: 64 * MiB,
    bootstrapRapUs: 60_000_000n,
    planRapAfterPlanningBytes: 14 * MiB,
    planningClocksByPush: [
      {ptsUs: 53_000_000n, offset: 60n * BigInt(MiB)},
      ...Array.from({length: 11}, () =>
        ({ptsUs: 48_000_000n, offset: 50n * BigInt(MiB)})),
    ],
  });
  const result = await seek.session.run();
  const planningBytes = seek.requests.filter(request => request.phase !== 'single-landing')
    .reduce((total, request) => total + request.length, 0n);
  assert.ok(planningBytes > 9n * BigInt(MiB) && planningBytes <= 16n * BigInt(MiB),
    `timed candidate evidence used ${planningBytes} bytes at ${JSON.stringify(
      seek.operations, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
  assert.equal(result.rapPresentationTimeUs, 49_000_000n);
  assert.equal(result.requestedTimeSeconds, 50);
}

{
  const seek = fixture({planRap: false, bootstrapRapUs: 60_000_000n});
  await assert.rejects(seek.session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'no-rap');
  const planningBytes = seek.requests.filter(request => request.phase !== 'single-landing')
    .reduce((total, request) => total + request.length, 0n);
  assert.ok(planningBytes <= 9n * BigInt(MiB),
    'an untimed empty probe expanded beyond the reserved landing budget');
}

{
  const {session, operations} = fixture({
    planRapsByPush: [[53_000_000n], [49_000_000n]],
  });
  const result = await session.run();
  assert.equal(result.rapPresentationTimeUs, 49_000_000n,
    'a future RAP did not redirect the remaining probe toward its preceding GOP');
  assert.ok(operations.filter(([phase]) => phase === 'backward-plan').length >= 2,
    'future-RAP planning did not perform the bounded earlier observation');
}

{
  const seek = fixture({
    reusedIndex: true,
    sourceSize: 64 * MiB,
    estimateBytes: 24 * MiB,
    indexedRestartBytes: 1 * MiB,
    landingAfterPushes: 24,
  });
  const result = await seek.session.run();
  assert.equal(result.budgetAuthorization.extended, true,
    'a proven long RAP-to-target span did not authorize the landing extension');
  assert.ok(result.budgetAuthorization.authorizationThresholdBytes >= 31n * BigInt(MiB),
    'the authorization omitted the fixed landing guard');
  assert.ok(result.budgetBytes > 16n * BigInt(MiB) &&
    result.budgetBytes <= 32n * BigInt(MiB),
  'the landing extension did not stay between the base and hard limits');
  assert.equal(result.budgetBytes, 32n * BigInt(MiB),
    'ordinary video did not use the fixed 32 MiB extension tier');
  assert.ok(result.bytesRead > 16n * BigInt(MiB) && result.bytesRead <= result.budgetBytes,
    'the extended landing did not consume its one authorized ledger');
  assert.equal(seek.operations.filter(([phase]) => phase === 'single-landing').length, 1,
    'an extended seek performed more than one formal landing reposition');
}

{
  const seek = fixture({
    reusedIndex: true,
    sourceSize: 96 * MiB,
    estimateBytes: 40 * MiB,
    indexedRestartBytes: 1 * MiB,
    landingAfterPushes: 40,
    videoWidth: 7680,
    videoHeight: 4320,
  });
  const result = await seek.session.run();
  assert.equal(result.budgetBytes, 48n * BigInt(MiB),
    '8K seek did not choose the smallest sufficient 48 MiB tier');
  assert.ok(result.bytesRead > 32n * BigInt(MiB),
    '8K seek did not exercise reads beyond the ordinary-video hard limit');
}

{
  const seek = fixture({
    reusedIndex: true,
    sourceSize: 96 * MiB,
    estimateBytes: 49 * MiB,
    indexedRestartBytes: 1 * MiB,
    videoWidth: 7680,
    videoHeight: 4320,
  });
  const result = await seek.session.run();
  assert.equal(result.budgetBytes, 64n * BigInt(MiB),
    '8K seek did not choose the 64 MiB tier for a span above 48 MiB');
}

{
  const seek = fixture({
    landing: 'natural-tail',
    reusedIndex: true,
    sourceSize: 128 * MiB,
    estimateBytes: 72 * MiB,
    indexedRestartBytes: 1 * MiB,
  });
  await assert.rejects(seek.session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted' &&
      error.diagnostics.maximumBudgetBytes === String(64 * MiB));
  assert.equal(seek.operations.filter(([phase]) => phase === 'single-landing').length, 1,
    'a saturated candidate did not retain exactly one formal landing');
  assert.equal(seek.requests.reduce((total, request) => total + request.length, 0n),
    64n * BigInt(MiB), 'a saturated seek crossed its 64 MiB hard tier');
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
  assert.ok(planOffsets.length >= 2 && planOffsets.every((offset, index) =>
    index === 0 || offset < planOffsets[index - 1]),
  'an empty sparse window did not continue expanding backward');
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
  const {session, media} = fixture({landing: 'natural-tail', sourceSize: 64 * MiB});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted');
  assert.equal(media.currentTime, 50);
}

{
  const {session} = fixture({landing: 'held-frame', gapSeconds: 0.251, sourceSize: 64 * MiB});
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
