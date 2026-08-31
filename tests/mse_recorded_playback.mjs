import assert from 'node:assert/strict';

import {
  MSE_RECORDED_READ_BUDGET_BYTES,
  createMseRecordedPlaybackController,
  resolveRecordedVideoWindow,
} from '../mse-recorded-playback.mjs';

const audio = {startTimeSeconds: 10, endTimeSeconds: 12, inputOffset: 100n};
const preferred = [{
  trackId: 1n, startTimeSeconds: 9, endTimeSeconds: 12.5,
  restartOffset: 80n, closed: true,
}];
const rainfall = [{
  trackId: 2n, startTimeSeconds: 9.5, endTimeSeconds: 13,
  restartOffset: 90n, closed: true,
}];
const frozen = [{
  trackId: 1n, startTimeSeconds: 8, endTimeSeconds: 8.04,
  restartOffset: 70n, closed: true, payloadId: 'closed-idr',
}];

assert.equal(resolveRecordedVideoWindow({audio, preferred, rainfall, frozen}).mode, 'preferred');
assert.equal(resolveRecordedVideoWindow({audio, preferred: [], rainfall, frozen}).mode, 'rainfall');
const frozenChoice = resolveRecordedVideoWindow({
  audio, preferred: [], rainfall: [], frozen,
});
assert.equal(frozenChoice.mode, 'frozen');
assert.equal(frozenChoice.video.payloadId, 'closed-idr');
assert.equal(resolveRecordedVideoWindow({
  audio, preferred: [], rainfall: [], frozen: [{...frozen[0], startTimeSeconds: 11}],
}), null, 'a future picture was copied backward into an earlier audio window');

function streamSource(chunks) {
  return {
    size: BigInt(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
    streams: [],
    reads: [],
    async read(offset, length) {
      this.reads.push([offset, length]);
      return new Uint8Array(Number(length));
    },
    async *stream(offset, {signal} = {}) {
      this.streams.push({offset, signal});
      for (const chunk of chunks) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        yield chunk;
      }
    },
  };
}

function queue() {
  return {
    stable: 0,
    async waitStable() { this.stable += 1; },
    bufferedRanges: () => [{start: 0, end: 20}],
    committedRanges: () => [{start: 0, end: 20}],
  };
}

const locateAtStart = async () => ({
  nextOffset: 0n, bytesRead: 0n, videoMode: 'preferred',
});

{
  const source = streamSource([Uint8Array.of(1), Uint8Array.of(2)]);
  const media = {currentTime: 0, playbackRate: 1};
  const pushes = [];
  const queues = new Map([['video', queue()], ['audio', queue()]]);
  const controller = createMseRecordedPlaybackController({
    source, media, queues,
    demuxer: {push: async data => pushes.push(data[0])},
    commonAhead: () => 0,
    locateSeekWindow: locateAtStart,
  });
  assert.deepEqual(controller.watermarks(), {highMediaSeconds: 2, lowMediaSeconds: 1});
  controller.setPlaybackRate(2);
  assert.deepEqual(controller.watermarks(), {highMediaSeconds: 4, lowMediaSeconds: 2});
  await controller.start();
  assert.deepEqual(pushes, [1, 2]);
  assert.equal(media.currentTime, 0, 'normal Recorded playback wrote currentTime');
  assert.equal(queues.get('video').stable, 3);
  assert.equal(queues.get('audio').stable, 3,
    'a source fragment advanced before both A/V queues acknowledged updateend');
  assert.equal(controller.state, 'ended');
}

{
  const source = streamSource([Uint8Array.of(1)]);
  const media = {currentTime: 12, playbackRate: 1};
  let videoWaits = 0;
  const video = {
    quotaBlocked: false,
    bufferedRanges: () => [{start: 0, end: 15}],
    committedRanges: () => [{start: 0, end: 15}],
    waitStable() {
      videoWaits += 1;
      if (videoWaits === 1) {
        this.quotaBlocked = true;
        const error = new Error('quota');
        error.name = 'MseAppendQuotaError';
        error.code = 'MSE_APPEND_QUOTA';
        return import('../mse-append-queue.mjs').then(({MseAppendQuotaError}) => {
          throw new MseAppendQuotaError();
        });
      }
      return Promise.resolve();
    },
    retryQuotaAfterRemove(end) {
      assert.equal(end, 7);
      this.quotaBlocked = false;
      return true;
    },
    canRetryQuotaAfterRemove(end) { return end === 7; },
  };
  const controller = createMseRecordedPlaybackController({
    source, media, queues: new Map([['video', video], ['audio', queue()]]),
    demuxer: {push: async () => {}}, commonAhead: () => 0,
    locateSeekWindow: locateAtStart,
  });
  controller.notifyPresentedFrame(10);
  await controller.start();
  assert.equal(videoWaits, 3, 'quota fragment was not retried exactly once after safe removal');
}

{
  const source = streamSource([Uint8Array.of(1)]);
  const media = {currentTime: 0, playbackRate: 1};
  let waits = 0;
  let retries = 0;
  let playbackStarts = 0;
  const video = {
    quotaBlocked: false,
    bufferedRanges: () => [{start: 0, end: 1}],
    committedRanges: () => [{start: 0, end: 1}],
    waitStable() {
      waits += 1;
      if (waits === 2) {
        this.quotaBlocked = true;
        return Promise.reject(Object.assign(new Error('quota'), {
          name: 'MseAppendQuotaError', code: 'MSE_APPEND_QUOTA',
        }));
      }
      return Promise.resolve();
    },
    canRetryQuotaAfterRemove(end) { return this.quotaBlocked && end > 1; },
    retryQuotaAfterRemove(end) {
      assert.ok(end > 1);
      retries += 1;
      this.quotaBlocked = false;
      return true;
    },
  };
  const controller = createMseRecordedPlaybackController({
    source, media, queues: new Map([['video', video], ['audio', queue()]]),
    demuxer: {push: async () => {}}, commonAhead: () => 1,
    locateSeekWindow: locateAtStart,
    play: () => {},
    onPlaybackStart: event => {
      assert.equal(event.quotaLimited, true);
      playbackStarts += 1;
    },
  });
  const completed = controller.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(playbackStarts, 1, 'quota-limited entry did not start consumption');
  assert.equal(retries, 0, 'quota retried without safe presented history');
  controller.notifyConsumption();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries, 0, 'ordinary consumption notification retried quota');
  controller.notifyPresentedFrame(4.1);
  await completed;
  assert.equal(retries, 1, 'presented history did not permit one retained-fragment retry');
}

{
  const source = streamSource([Uint8Array.of(1)]);
  const media = {currentTime: 7, playbackRate: 1};
  const switches = [];
  const controller = createMseRecordedPlaybackController({
    source, media, queues: new Map([['video', queue()], ['audio', queue()]]),
    demuxer: {push: async () => {}}, commonAhead: () => 2,
    locateSeekWindow: locateAtStart,
    switchVideoMode: mode => switches.push(mode),
  });
  controller.reportPlaybackQuality({totalFrames: 100, droppedFrames: 21, durationSeconds: 5});
  assert.deepEqual(switches, []);
  controller.reportPlaybackQuality({totalFrames: 100, droppedFrames: 25, durationSeconds: 5});
  assert.deepEqual(switches, ['rainfall']);
  assert.equal(controller.videoMode, 'rainfall');
  controller.notifyPreferredStableRap();
  assert.equal(controller.videoMode, 'rainfall',
    'performance fallback returned to preferred before an explicit seek/reload');
  assert.equal(media.currentTime, 7, 'quality fallback wrote currentTime');
}

{
  let firstAbort = null;
  const source = {
    size: 64n,
    async read() { return Uint8Array.of(0); },
    async *stream(offset, {signal}) {
      if (offset === 0n) {
        firstAbort = signal;
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
        throw new DOMException('aborted', 'AbortError');
      }
      yield Uint8Array.of(2);
    },
  };
  const media = {currentTime: 5, playbackRate: 1};
  const controller = createMseRecordedPlaybackController({
    source, media, queues: new Map([['video', queue()], ['audio', queue()]]),
    demuxer: {push: async () => {}}, commonAhead: () => 0,
    locateSeekWindow: async ({targetTimeSeconds, readBudgetBytes}) => {
      if (targetTimeSeconds === 5) {
        return {nextOffset: 0n, bytesRead: 0n, videoMode: 'preferred'};
      }
      assert.equal(targetTimeSeconds, 12);
      assert.equal(readBudgetBytes, BigInt(MSE_RECORDED_READ_BUDGET_BYTES));
      assert.equal(media.currentTime, 5, 'seek probe changed currentTime before commit');
      return {nextOffset: 10n, bytesRead: 4n, videoMode: 'frozen'};
    },
  });
  const running = controller.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = await controller.seek(12);
  assert.equal(firstAbort.aborted, true, 'explicit seek did not cancel the old sequential stream');
  assert.equal(result.nextOffset, 10n);
  assert.equal(media.currentTime, 12, 'explicit seek did not install its unchanged target after commit');
  assert.equal(controller.videoMode, 'frozen');
  await running;
  await controller.stop();
}

console.log('MSE Recorded playback controller tests passed');
