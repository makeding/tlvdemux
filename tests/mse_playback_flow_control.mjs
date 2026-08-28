import assert from 'node:assert/strict';

import {
  MSE_STARTUP_NO_COMMON_AV,
  commonBufferedAhead,
  createMsePlaybackFlowControl,
} from '../mse-playback.mjs';

const queue = ranges => ({
  ranges,
  bufferedRanges() { return this.ranges; },
  trimBefore() {},
  waitFlowControlled() { return Promise.resolve(); },
});

{
  const media = {currentTime: 0};
  const queues = new Map([
    ['video', queue([{start: 0.821944, end: 4}])],
    ['audio', queue([{start: 0.821944, end: 4}])],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues});
  await assert.rejects(
    flow.afterPush(2 * 1024 * 1024),
    error => error.code === MSE_STARTUP_NO_COMMON_AV,
    'detached startup A/V did not stop further input immediately');
}

{
  const media = {currentTime: 0};
  const queues = new Map([
    ['video', queue([])],
    ['audio', queue([])],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues});
  let bytes = 0;
  await assert.rejects(async () => {
    while (true) {
      bytes += 2 * 1024 * 1024;
      await flow.afterPush(2 * 1024 * 1024);
    }
  }, error => error.code === MSE_STARTUP_NO_COMMON_AV);
  assert.equal(bytes, 16 * 1024 * 1024,
    'startup without MSE progress exceeded the 16 MiB input budget');
}

{
  const media = {currentTime: 0};
  const video = queue([{start: 0, end: 16}]);
  const audio = queue([{start: 0, end: 16}]);
  const queues = new Map([['video', video], ['audio', audio]]);
  let waits = 0;
  const flow = createMsePlaybackFlowControl({
    media,
    queues,
    wait: async () => {
      waits += 1;
      media.currentTime = 9;
    },
  });
  await flow.afterPush(2 * 1024 * 1024);
  assert.equal(waits, 1, '15-second high-water mark did not pause input');
  assert.equal(commonBufferedAhead(media, queues), 7,
    'input resumed before common A/V fell below the 8-second low-water mark');
}

console.log('MSE playback flow-control tests passed');
