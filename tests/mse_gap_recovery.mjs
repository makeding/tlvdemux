import assert from 'node:assert/strict';

import {
  commonBufferedRanges,
  createMsePlaybackDamageRecovery,
  startMsePlayback,
} from '../mse-playback.mjs';

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
  let writes = 0;
  let clock = 0;
  const player = {
    get currentTime() { return clock; },
    set currentTime(value) { writes += 1; clock = value; },
    playCount: 0,
    play() { this.playCount += 1; return Promise.resolve(); },
  };
  const started = startMsePlayback({
    media: player,
    queues: queues([{start: 0.821944, end: 4}], [{start: 0.821944, end: 4}]),
  });
  assert.equal(started, null,
    'fresh recorded playback accepted A/V that did not cover timestamp zero');
  assert.equal(writes, 0,
    'fresh recorded playback aligned currentTime to a later buffered range');
  assert.equal(player.currentTime, 0);
  assert.equal(player.playCount, 0);
}

{
  let writes = 0;
  let clock = 0;
  const player = {
    get currentTime() { return clock; },
    set currentTime(value) { writes += 1; clock = value; },
    playCount: 0,
    play() { this.playCount += 1; return Promise.resolve(); },
  };
  const started = startMsePlayback({
    media: player,
    queues: queues([{start: 0, end: 4}], [{start: 0, end: 4}]),
  });
  assert.ok(started, 'timestamp-mapped rainfall A/V did not start playback');
  assert.equal(writes, 0, 'timestamp-mapped startup wrote currentTime');
  assert.equal(player.playCount, 1);
}

{
  let writes = 0;
  let clock = 0;
  const player = {
    get currentTime() { return clock; },
    set currentTime(value) { writes += 1; clock = value; },
    play() { return Promise.resolve(); },
  };
  const started = startMsePlayback({
    media: player,
    queues: queues([{start: 10, end: 12}], [{start: 10, end: 12}]),
    liveMode: true,
    minimumLiveBufferSeconds: 0.5,
  });
  assert.ok(started?.aligned, 'live startup did not retain its explicit range alignment');
  assert.equal(writes, 1);
  assert.equal(player.currentTime, 10);
}

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
  const recovery = createMsePlaybackDamageRecovery({
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
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    presentationStartUs: 2_000_000n,
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
    startTimeUs: 48_000_000,
    recoveryTimeUs: 62_000_000,
  });
  assert.deepEqual(jumps, [{target: 60, previous: 46}],
    'current-layer recovery RAP did not map through the union presentation start');
  recovery.reportDamage({
    videoTrackId: 3,
    action: 'seek',
    startTimeUs: 48_000_000,
    recoveryTimeUs: 62_000_000,
  });
  assert.equal(jumps.length, 1, 'the same playback damage repositioned media more than once');
  recovery.reset();
  player.currentTime = 46;
  recovery.reportDamage({
    videoTrackId: 3,
    action: 'seek',
    startTimeUs: 48_000_000,
    recoveryTimeUs: 62_000_000,
  });
  assert.deepEqual(jumps, [{target: 60, previous: 46}, {target: 60, previous: 46}],
    'an explicit recovery reset did not allow a later playback session to recover');
}

{
  const player = media(1);
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: target => {
      jumps.push(target);
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek',
    startTimeUs: 10_000_000,
    recoveryTimeUs: 15_000_000,
  });
  assert.deepEqual(jumps, [], 'parser prefetch skipped healthy media before its damage span');
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [], 'waiting before the authorized damage span triggered a seek');
  player.currentTime = 9.95;
  recovery.notifyWaiting();
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [15],
    'waiting did not execute the retained PlaybackDamage seek exactly once');
}

{
  const player = media(9);
  const jumps = [];
  let currentVideoTrackId = 2;
  let switchInFlight = false;
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    isCurrentLayer: damage => damage.videoTrackId === currentVideoTrackId,
    switchInFlight: () => switchInFlight,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  const stalled = {
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 10_000_000,
    recoveryTimeUs: 11_500_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  };
  recovery.reportDamage(stalled);
  assert.deepEqual(jumps, [],
    'parser prefetch executed seek-if-stalled without a waiting event');
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'waiting before the short damage span executed seek-if-stalled');

  player.currentTime = 10.75;
  switchInFlight = true;
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'waiting executed seek-if-stalled while a layer switch was in flight');
  switchInFlight = false;
  recovery.reportDamage(stalled);
  assert.deepEqual(jumps, [],
    'waiting observed during a layer switch authorized a later recovery RAP');
  currentVideoTrackId = 3;
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'waiting executed seek-if-stalled for a non-current video track');

  currentVideoTrackId = 2;
  recovery.reportDamage(stalled);
  recovery.notifyWaiting();
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 11.5, previous: 10.75}],
    'matching waiting did not execute seek-if-stalled exactly once at the recovery RAP');
}

{
  const player = media(12);
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: target => jumps.push(target),
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 10_000_000,
    recoveryTimeUs: 11_500_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  recovery.notifyWaiting();
  player.currentTime = 10.5;
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'a stale seek-if-stalled candidate caused a later backward seek');
}

{
  const player = media(6.58);
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 5_873_000,
    recoveryTimeUs: 6_273_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  recovery.observePresentedFrame(5.9);
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'late waiting jumped backward to the already-passed first recovery RAP');
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 6_806_806,
    ptsTimescale: 1_000_000,
  });
  assert.deepEqual(jumps, [{target: 6.806806, previous: 6.58}],
    'late waiting did not recover at the next parser-observed forward RAP');
}

{
  const player = media(6.58);
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: target => jumps.push(target),
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 5_873_000,
    recoveryTimeUs: 6_273_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 6_806_806,
    ptsTimescale: 1_000_000,
  });
  recovery.observePresentedFrame(6.3);
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'a frame presented beyond the recovery RAP did not retire stale damage');
}

{
  const player = media(6.58);
  const jumps = [];
  let targetBuffered = false;
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    isTargetBuffered: target => target < 6.5 || targetBuffered,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 5_873_000,
    recoveryTimeUs: 6_273_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  recovery.observePresentedFrame(5.9);
  recovery.notifyWaiting();
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 6_806_806,
    ptsTimescale: 1_000_000,
  });
  assert.deepEqual(jumps, [], 'an unbuffered forward RAP triggered recovery');
  targetBuffered = true;
  recovery.notifyBufferedChange();
  recovery.notifyBufferedChange();
  assert.deepEqual(jumps, [{target: 6.806806, previous: 6.58}],
    'buffer progress did not execute forward recovery exactly once');
}

{
  const callbacks = new Map();
  const cancelled = [];
  let nextCallback = 1;
  const player = {
    ...media(6.58),
    requestVideoFrameCallback(callback) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    cancelVideoFrameCallback(id) { cancelled.push(id); callbacks.delete(id); },
  };
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: target => jumps.push(target),
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 5_873_000,
    recoveryTimeUs: 6_273_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  const firstFrameCallback = callbacks.values().next().value;
  callbacks.clear();
  firstFrameCallback(0, {mediaTime: 6.3, presentedFrames: 100});
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 6_806_806,
    ptsTimescale: 1_000_000,
  });
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [],
    'automatic presented-frame observation did not retire recovered damage');
  recovery.destroy();
  assert.equal(cancelled.length, 1,
    'destroy did not cancel the outstanding presented-frame callback');
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [], 'destroyed recovery coordinator remained active');
}

console.log('MSE gap recovery tests passed');
