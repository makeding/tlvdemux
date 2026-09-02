import assert from 'node:assert/strict';

import {
  MSE_STARTUP_NO_COMMON_AV,
  commonBufferedAhead,
  createMsePlaybackFlowControl,
  startMsePlayback,
} from '../mse-playback.mjs';

const queue = (ranges, committed = ranges) => ({
  ranges,
  committed,
  bufferedRanges() { return this.ranges; },
  committedRanges() { return this.committed; },
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
  for (let push = 1; push < 8; push += 1) {
    const result = await flow.afterPush(2 * 1024 * 1024);
    assert.equal(result.entryCovered, false,
      'unmapped startup A/V was incorrectly classified as timestamp-zero media');
  }
  await assert.rejects(flow.afterPush(2 * 1024 * 1024), error =>
    error.code === MSE_STARTUP_NO_COMMON_AV,
  'unmapped startup A/V did not stop at the 16 MiB input budget');
}

{
  const media = {currentTime: 50};
  const video = queue([{start: 50.01, end: 53}]);
  const audio = queue([{start: 49, end: 53}]);
  const queues = new Map([['video', video], ['audio', audio]]);
  const flow = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: 50,
  });
  assert.equal(flow.entryCovered(), false,
    'recorded seek accepted later-only A/V without exact-target coverage');
  video.ranges = [{start: 50.000001, end: 53}];
  video.committed = video.ranges;
  assert.equal(flow.entryCovered(), true,
    'recorded seek rejected a one-tick exact-target rounding boundary');
  assert.equal(media.currentTime, 50,
    'recorded seek flow control moved the requested media time');
}

{
  const target = 341.943285;
  const video = queue([{start: 341.941462, end: 346.095611}]);
  const audio = queue([{start: 341.961889, end: 345.737889}]);
  const queues = new Map([['video', video], ['audio', audio]]);
  const flow = createMsePlaybackFlowControl({
    media: {currentTime: target}, queues, entryKind: 'seek', entryTimeSeconds: target,
  });
  assert.equal(flow.entryCovered(), true,
    'exact video plus a first AAC frame within one frame boundary was rejected');
  assert.equal(flow.landingMode(), 'exact');
  audio.ranges = [{start: target + 0.022001, end: 345.737889}];
  audio.committed = audio.ranges;
  assert.equal(flow.entryCovered(), false,
    'an audio gap beyond one AAC frame was accepted as an exact landing');
}

{
  const media = {currentTime: 50};
  const video = queue([{start: 49, end: 53}], []);
  const audio = queue([{start: 49, end: 53}], []);
  const queues = new Map([['video', video], ['audio', audio]]);
  const flow = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: 50,
  });
  assert.equal(flow.entryCovered(), false,
    'browser-buffered ranges authorized a seek before coded A/V was committed');
  video.committed = [{start: 49, end: 53}];
  audio.committed = [{start: 49, end: 53}];
  audio.ranges = [{start: 51, end: 53}];
  assert.equal(flow.entryCovered(), false,
    'committed coded A/V authorized a seek without a real SourceBuffer intersection');
  audio.ranges = [{start: 49, end: 53}];
  assert.equal(flow.entryCovered(), true,
    'joint committed and browser-buffered coverage did not authorize an exact seek');
  assert.equal(flow.landingMode(), 'exact');
}

{
  const media = {currentTime: 0};
  const queues = new Map([
    ['video', queue([{start: 0.533873, end: 4}])],
    ['audio', queue([{start: 0, end: 4}])],
  ]);
  const flow = createMsePlaybackFlowControl({
    media,
    queues,
    entryKind: 'seek',
    entryTimeSeconds: 0,
    allowNaturalStart: true,
  });
  assert.equal(flow.entryCovered(), true,
    'recording-start audio plus a later real RAP did not authorize natural start');
  assert.equal(flow.landingMode(), 'natural-start');
  assert.equal(media.currentTime, 0,
    'natural start moved the requested media clock away from zero');
  const nonzero = createMsePlaybackFlowControl({
    media: {currentTime: 0.2},
    queues,
    entryKind: 'seek',
    entryTimeSeconds: 0.2,
    allowNaturalStart: true,
  });
  assert.equal(nonzero.entryCovered(), false,
    'natural-start relaxation was applied away from the recording start');
}

{
  const media = {
    currentTime: 0,
    playCount: 0,
    play() { this.playCount += 1; return Promise.resolve(); },
  };
  const video = queue([]);
  const audio = queue([{start: 0, end: 16}]);
  const queues = new Map([['video', video], ['audio', audio]]);
  const flow = createMsePlaybackFlowControl({
    media, queues, requiredTracks: ['audio'],
    wait: async () => { media.currentTime = 9; },
  });
  assert.deepEqual(flow.entryRange(), {start: 0, end: 16},
    'audio-only entry waited for an empty video queue');
  await flow.afterPush(2 * 1024 * 1024);
  assert.equal(flow.commonAhead(), 7,
    'audio-only backpressure did not use the audio clock/range');
  const started = startMsePlayback({media, queues, requiredTracks: ['audio']});
  assert.ok(started, 'audio-only playback did not start from an audio range');
  assert.equal(media.playCount, 1);
  flow.setRequiredTracks(['video', 'audio']);
  assert.equal(flow.entryRange(), null,
    'restored A/V flow did not resume strict video/audio intersection');
}

{
  const media = {currentTime: 0};
  const queues = new Map([
    ['video', queue([{start: 0, end: 4}])],
    ['audio', queue([{start: 0, end: 4}])],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues});
  const result = await flow.afterPush(2 * 1024 * 1024);
  assert.equal(result.entryCovered, true,
    'timestamp-mapped manual startup switch was classified as no-common-A/V');
}

{
  const media = {
    currentTime: 0,
    playCount: 0,
    play() { this.playCount += 1; return Promise.resolve(); },
  };
  const queues = new Map([
    ['video', queue([{start: 10, end: 14}])],
    ['audio', queue([{start: 10.01, end: 14}])],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues, entryKind: 'live'});
  const result = await flow.afterPush(2 * 1024 * 1024);
  assert.equal(result.entryCovered, true,
    'valid live A/V was classified as missing timestamp-zero startup media');
  assert.deepEqual(flow.entryRange(), {start: 10.01, end: 14});
  assert.equal(result.commonAhead, 3.99,
    'live flow control did not measure its first common range before clock alignment');
  assert.equal(media.currentTime, 0,
    'live flow control aligned the media clock before playback startup accepted the buffer');
  const started = startMsePlayback({
    media, queues, liveMode: true, minimumLiveBufferSeconds: 3,
  });
  assert.ok(started?.aligned, 'live playback did not align to its accepted common A/V entry');
  assert.equal(media.currentTime, 10.01);
  assert.equal(media.playCount, 1);
}

{
  let visibleTime = 0;
  let currentTimeWrites = 0;
  const media = {
    get currentTime() { return visibleTime; },
    set currentTime(value) {
      currentTimeWrites += 1;
      visibleTime = value;
    },
  };
  const queues = new Map([
    ['video', {...queue([]), waitFlowControlled() {
      throw new Error('stalled Live video MSE callback must not gate input');
    }}],
    ['audio', {...queue([]), waitFlowControlled() {
      throw new Error('stalled Live audio MSE callback must not gate input');
    }}],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues, entryKind: 'live'});
  let bytes = 0;
  for (let push = 0; push < 20; push += 1) {
    bytes += 2 * 1024 * 1024;
    const result = await flow.afterPush(2 * 1024 * 1024);
    assert.deepEqual(result, {commonAhead: 0, entryCovered: false},
      'temporary Live A/V loss stopped accepting input while recovery evidence was absent');
  }
  assert.equal(bytes, 40 * 1024 * 1024,
    'Live recovery test did not cross the former 16 MiB fatal boundary');
  assert.equal(currentTimeWrites, 0,
    'Live flow control moved the visible media clock while waiting in place');
  assert.equal(media.currentTime, 0,
    'Live flow control changed the visible stalled position');
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
