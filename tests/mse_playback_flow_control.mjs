import assert from 'node:assert/strict';

import {
  MSE_STARTUP_NO_COMMON_AV,
  commonBufferedAhead,
  createMsePlaybackFlowControl,
  startMsePlayback,
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
  const media = {currentTime: 0};
  const queues = new Map([
    ['video', queue([])],
    ['audio', queue([])],
  ]);
  const flow = createMsePlaybackFlowControl({media, queues, entryKind: 'live'});
  let bytes = 0;
  await assert.rejects(async () => {
    while (true) {
      bytes += 2 * 1024 * 1024;
      await flow.afterPush(2 * 1024 * 1024);
    }
  }, error => error.code === MSE_STARTUP_NO_COMMON_AV &&
    error.message.includes('common live A/V range'));
  assert.equal(bytes, 16 * 1024 * 1024,
    'live startup without common A/V exceeded the 16 MiB input budget');
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
