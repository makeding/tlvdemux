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
    [{start: 0, end: 46}, {start: 71, end: 90}],
    [{start: 0, end: 46}, {start: 71, end: 90}],
  );
  assert.deepEqual(commonBufferedRanges(sourceQueues), [
    {start: 0, end: 46},
    {start: 71, end: 90},
  ]);
  const player = media(46);
  const jumps = [];
  const recovery = createMseGapRecovery({
    media: player,
    seek: target => {
      jumps.push(target);
      player.currentTime = target;
    },
  });
  recovery.notifyWaiting();
  assert.equal(player.currentTime, 46,
    'waiting inferred that the unobserved interval was damaged');
  assert.deepEqual(jumps, [],
    'a later buffered range authorized an unsupported seek');
}

{
  const player = media(46);
  const jumps = [];
  let currentVideoTrackId = 2;
  let switchInFlight = false;
  const recovery = createMseGapRecovery({
    media: player,
    isCurrentLayer: damage => damage.videoTrackId === currentVideoTrackId,
    switchInFlight: () => switchInFlight,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    videoTrackId: 3,
    action: 'seek',
    recoveryTimeUs: 60_000_000,
  });
  assert.deepEqual(jumps, [], 'inactive-layer damage repositioned playback');

  switchInFlight = true;
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek',
    recoveryTimeUs: 61_000_000,
  });
  assert.deepEqual(jumps, [], 'layer switch and seek ran concurrently');

  switchInFlight = false;
  currentVideoTrackId = 3;
  recovery.reportDamage({
    videoTrackId: 3,
    action: 'wait-for-recovery',
    recoveryTimeUs: null,
  });
  assert.deepEqual(jumps, [], 'wait-for-recovery invented a target');
  recovery.reportDamage({
    videoTrackId: 3,
    action: 'seek',
    recoveryTimeUs: 62_000_000,
  });
  assert.deepEqual(jumps, [{target: 62, previous: 46}],
    'current-layer recovery RAP did not authorize the exact seek');
}

console.log('MSE gap recovery tests passed');
