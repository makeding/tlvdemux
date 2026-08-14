import assert from 'node:assert/strict';

import {
  commonBufferedRanges,
  createMseGapRecovery,
} from '../demo/mse-gap-recovery.mjs';

const queue = ranges => ({bufferedRanges: () => ranges});
const queues = (video, audio) => new Map([
  ['video', queue(video)],
  ['audio', queue(audio)],
]);
const media = currentTime => ({
  currentTime,
  paused: false,
  seeking: false,
  playCount: 0,
  play() {
    this.playCount += 1;
    return Promise.resolve();
  },
});

{
  const sourceQueues = queues(
    [{start: 0, end: 307.14}, {start: 334.37, end: 375.63}],
    [{start: 0, end: 306.94}, {start: 334.48, end: 375.22}],
  );
  assert.deepEqual(commonBufferedRanges(sourceQueues), [
    {start: 0, end: 306.94},
    {start: 334.48, end: 375.22},
  ]);

  const player = media(306.94);
  let producerFinished = false;
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    seek: (target, previous) => {
      jumps.push({target, previous, producerFinished});
      player.currentTime = target;
    },
  });
  producerFinished = true;
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 334.48, previous: 306.94, producerFinished: true}],
    'a waiting event after input finalization did not cross the recorded A/V gap');
  assert.equal(player.playCount, 1);
}

{
  const sourceQueues = queues(
    [{start: 0, end: 307.14}, {start: 334.37, end: 375.63}],
    [{start: 0, end: 306.94}, {start: 334.48, end: 375.22}],
  );
  const player = media(298.0);
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 334.48, previous: 298.0}],
    'decoder underflow inside an optimistic buffered range did not skip to later A/V data');
}

{
  const sourceQueues = queues(
    [{start: 0, end: 375.63}],
    [{start: 0, end: 375.22}],
  );
  const player = media(298.0);
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    action: 'seek',
    startTimeUs: 298000000,
    endTimeUs: 334901211,
    recoveryTimeUs: 334901211,
  });
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 334.901211, previous: 298.0}],
    'known source damage did not override Chromium\'s optimistic continuous range');
}

{
  const sourceQueues = queues(
    [{start: 0, end: 375.63}],
    [{start: 0, end: 375.22}],
  );
  const player = media(306.108);
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    action: 'seek',
    startTimeUs: 307407077,
    endTimeUs: 334901211,
    recoveryTimeUs: 334901211,
  });
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 334.901211, previous: 306.108}],
    'source-damage lead tolerance did not cover the last decodable sample boundary');
}

{
  let videoRanges = [
    {start: 0, end: 10},
    {start: 20, end: 20.2},
  ];
  let audioRanges = [
    {start: 0, end: 10},
    {start: 20, end: 20.2},
  ];
  const sourceQueues = queues(videoRanges, audioRanges);
  sourceQueues.get('video').bufferedRanges = () => videoRanges;
  sourceQueues.get('audio').bufferedRanges = () => audioRanges;
  const player = media(10);
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    liveMode: true,
    liveStartupBufferSeconds: 0.5,
    seek: target => {
      jumps.push(target);
      player.currentTime = target;
    },
  });

  recovery.notifyWaiting();
  assert.deepEqual(jumps, [], 'Live recovery accepted an undersized future range');
  videoRanges = [...videoRanges, {start: 21, end: 22}];
  audioRanges = [...audioRanges, {start: 21.1, end: 21.8}];
  recovery.update();
  assert.deepEqual(jumps, [21.1], 'Live recovery did not resume after enough common data arrived');
}

{
  const sourceQueues = queues(
    [{start: 0, end: 10}, {start: 20, end: 30}],
    [{start: 0, end: 10}, {start: 20, end: 30}],
  );
  const player = media(10);
  player.paused = true;
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    queues: sourceQueues,
    seek: target => jumps.push(target),
  });
  recovery.notifyWaiting();
  player.paused = false;
  player.seeking = true;
  recovery.update();
  assert.deepEqual(jumps, [], 'paused or seeking playback crossed a buffered gap');
  player.seeking = false;
  recovery.update();
  assert.deepEqual(jumps, [20]);
}

console.log('MSE gap recovery tests passed');
