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
  targetTimeSeconds = 50, bootstrapRapUs = 0n, planRap = true, indexedRap = null,
  estimateOffsetBytes = 16 * MiB,
} = {}) {
  const media = {currentTime: targetTimeSeconds};
  const video = queue();
  const audio = queue();
  const queues = new Map([['video', video], ['audio', audio]]);
  const requests = [];
  const operations = [];
  const lifecycle = [];
  let position = 0n;
  let session;
  const source = {
    size: 32n * BigInt(MiB),
    async read(offset, length) {
      requests.push({phase: session?.phase, offset, length});
      return new Uint8Array(Number(length));
    },
  };
  const videoTrack = {kind: 'video', codec: 'hevc', trackId: 1};
  const audioTrack = {kind: 'audio', codec: 'aac-latm', trackId: 2};
  const demuxer = {
    async beginMseRecordedSeek() { lifecycle.push(['begin']); },
    async finishMseRecordedSeek(target) { lifecycle.push(['finish', target, session.phase]); },
    async cancelMseRecordedSeek() { lifecycle.push(['cancel', session.phase]); },
    async flushMseRecordedSeekLanding() {},
    async setMseOutputEnabled() {},
    async setMseTimestampOffset() {},
    async setIndexDuration() { return true; },
    async estimateOffset() { return BigInt(estimateOffsetBytes); },
    async previousSync() { return indexedRap; },
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
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 51_000_000n, ptsTimescale: 1_000_000,
          randomAccess: true, restartOffset: position,
        });
        session.observeAccessUnit({
          codec: 'hevc', trackId: 1, ptsValue: 53_000_000n, ptsTimescale: 1_000_000,
          randomAccess: false, restartOffset: position,
        });
      } else if (session.phase === 'single-landing') {
        video.ranges = [{start: targetTimeSeconds - 1, end: targetTimeSeconds + 3}];
        audio.ranges = landing === 'exact'
          ? [{start: targetTimeSeconds - 1, end: targetTimeSeconds + 3}]
          : [{start: targetTimeSeconds - 1, end: targetTimeSeconds - gapSeconds}];
      }
      position += BigInt(data.byteLength);
      return true;
    },
  };
  const flowControl = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: targetTimeSeconds,
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
    landingReserveBytes: MiB,
  });
  return {session, media, requests, operations, lifecycle, flowControl};
}

{
  const indexedRap = {
    presentationTimeUs: 51_000_000n,
    signallingOffset: 11n * BigInt(MiB),
    randomAccessOffset: 12n * BigInt(MiB),
    videoTrackId: 1,
  };
  const {session, operations} = fixture({planRap: false, indexedRap});
  const result = await session.run();
  assert.equal(result.restartOffset, indexedRap.signallingOffset,
    'a retained RecordingIndex preceding RAP was ignored');
  assert.equal(operations.filter(([phase]) => phase === 'backward-plan').length, 0,
    'an indexed RAP still triggered raw sparse planning');
}

{
  const {session} = fixture({planRap: false});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'no-rap' &&
      error.diagnostics.phase === 'backward-plan');
}

{
  const {session, operations} = fixture({
    targetTimeSeconds: 1,
    bootstrapRapUs: 2_000_000n,
  });
  const result = await session.run();
  assert.equal(result.restartOffset, 0n,
    'a target within the bootstrap preroll did not reuse the presentation-start RAP');
  assert.equal(operations.filter(([phase]) => phase === 'backward-plan').length, 0,
    'a near-start seek wasted its landing budget on backward planning');
}

{
  const {session, requests} = fixture({estimateOffsetBytes: 20 * MiB});
  await session.run();
  const plannerReads = requests.filter(request => request.phase === 'backward-plan');
  assert.equal(plannerReads.length, 1,
    'backward planning kept reading after it found a usable preceding RAP');
  assert.equal(plannerReads[0].offset, 4n * BigInt(MiB),
    'planner did not start from the conservative pre-estimate window');
}

{
  const {session, media, requests, operations, lifecycle} = fixture();
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
  assert.equal(requests.reduce((total, request) => total + request.length, 0n), result.bytesRead,
    'the single seek ledger did not account for every source read');
  assert.deepEqual(lifecycle, [['begin'], ['finish', 50_000_000n, 'committing']]);
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
  const result = await session.run();
  assert.equal(result.landingMode, 'held-frame');
  assert.equal(result.landingEvidence.landingMode, 'exact');
  assert.equal(result.heldFrameTimeSeconds, null,
    'AAC-tail-only playback fabricated a frozen video-frame timestamp');
  assert.equal(result.recoveryTimeSeconds, null,
    'AAC-tail-only playback fabricated a video recovery timestamp');
  assert.equal(media.currentTime, 50);
}

{
  const {session} = fixture({landing: 'held-frame', gapSeconds: 0.251});
  await assert.rejects(session.run(), error =>
    error.code === MSE_SEEK_NO_COMMON_AV && error.reason === 'budget-exhausted' &&
      error.diagnostics.phase === 'single-landing');
}

{
  const {session, requests} = fixture({landing: 'held-frame', budget: 4 * MiB});
  await session.run();
  assert.equal(requests.reduce((total, request) => total + request.length, 0n), 1n * BigInt(MiB),
    'seek read after completing a held-frame landing');
}

console.log('MSE recorded seek tests passed');
