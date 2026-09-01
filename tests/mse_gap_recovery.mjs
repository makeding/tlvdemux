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
  assert.equal(player.playCount, 0,
    'ordinary waiting without selected-video damage started playback');
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
  const player = media(10.75);
  player.paused = true;
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
    action: 'seek-if-stalled',
    startTimeUs: 10_000_000,
    recoveryTimeUs: 11_500_000,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 250n,
  });
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [], 'authorized paused recovery consumed its retained target');
  assert.equal(player.playCount, 0,
    'SDK recovery overrode a genuine user-paused MediaElement');
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
  let frameCallbackId = 0;
  const player = {
    ...media(13.245),
    requestVideoFrameCallback() { frameCallbackId += 1; return frameCallbackId; },
    cancelVideoFrameCallback() {},
  };
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
    },
  });
  const damage = {
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 11_200_000,
    recoveryTimeUs: 11_611_606,
    startInputOffset: 400n,
    endInputOffset: 500n,
    recoveryInputOffset: 600n,
    recoveryRestartOffset: 550n,
  };
  recovery.reportDamage(damage);
  recovery.observePresentedFrame(7.291);
  for (const target of [13.747079, 14.280934]) {
    recovery.observeAccessUnit({
      codec: 'hevc',
      trackId: 2,
      randomAccess: true,
      ptsValue: Math.round(target * 1_000_000),
      ptsTimescale: 1_000_000,
    });
  }
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [{target: 13.747079, previous: 13.245}],
    'the observed 13.245s stall did not select its first forward parser RAP');

  recovery.reportDamage(damage);
  recovery.notifyBufferedChange();
  assert.equal(jumps.length, 1,
    'a currentTime assignment, duplicate damage, or buffer progress completed/repeated recovery');
  recovery.observePresentedFrame(7.291);
  player.seeking = true;
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [
    {target: 13.747079, previous: 13.245},
    {target: 14.280934, previous: 13.747079},
  ], 'a causal waiting during the SDK-owned recovery seek did not advance');
  player.seeking = false;
  recovery.notifyBufferedChange();
  assert.deepEqual(jumps, [
    {target: 13.747079, previous: 13.245},
    {target: 14.280934, previous: 13.747079},
  ], 'seeked/buffer progress did not consume the retained repeated waiting exactly once');

  recovery.observePresentedFrame(11.7);
  recovery.notifyWaiting();
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 14_814_806,
    ptsTimescale: 1_000_000,
  });
  assert.equal(jumps.length, 2,
    'a compositor-presented recovery frame did not complete the retained authorization');
  recovery.destroy();
}

{
  let frameCallbackId = 0;
  const player = {
    ...media(6.589),
    play() { this.playCount += 1; this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback() { frameCallbackId += 1; return frameCallbackId; },
    cancelVideoFrameCallback() {},
  };
  const jumps = [];
  const recovery = createMsePlaybackDamageRecovery({
    media: player,
    seek: (target, previous) => {
      jumps.push({target, previous});
      player.currentTime = target;
      player.paused = true;
      player.seeking = true;
    },
  });
  recovery.reportDamage({
    videoTrackId: 2,
    action: 'seek-if-stalled',
    startTimeUs: 5_873_000,
    recoveryTimeUs: 6_272_934,
    startInputOffset: 700n,
    endInputOffset: 800n,
    recoveryInputOffset: 900n,
    recoveryRestartOffset: 850n,
  });
  recovery.observePresentedFrame(0.617);
  for (const target of [6.806806, 7.340679, 7.874540]) {
    recovery.observeAccessUnit({
      codec: 'hevc',
      trackId: 2,
      randomAccess: true,
      ptsValue: Math.round(target * 1_000_000),
      ptsTimescale: 1_000_000,
    });
  }
  player.seeking = false;
  recovery.notifyWaiting();
  recovery.notifyWaiting();
  recovery.notifyWaiting();
  assert.deepEqual(jumps, [
    {target: 6.806806, previous: 6.589},
    {target: 7.340679, previous: 6.806806},
    {target: 7.87454, previous: 7.340679},
  ], 'the observed 7.341s waiting was blocked by the SDK-owned seeking state');
  assert.equal(player.playCount, 0,
    'SDK-owned recovery seeks called visible MediaElement.play()');

  player.currentTime = 30;
  recovery.observeAccessUnit({
    codec: 'hevc',
    trackId: 2,
    randomAccess: true,
    ptsValue: 30_500_000,
    ptsTimescale: 1_000_000,
  });
  recovery.notifyWaiting();
  assert.equal(jumps.length, 3,
    'an unrelated MediaElement seeking target reused the damage authorization');
  recovery.destroy();
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
