import assert from 'node:assert/strict';

import {
  MSE_STARTUP_NO_COMMON_AV,
  commonBufferedAhead,
  createMsePlaybackFlowControl,
  startMsePlayback,
} from '../mse-playback.mjs';

const queue = (ranges, committed = ranges, queuedBytes = 0) => ({
  ranges,
  committed,
  queuedBytes,
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
  video.committed = [{start: 50.000001, end: 53}];
  assert.equal(flow.entryCovered(), true,
    'recorded seek rejected a one-tick exact-target rounding boundary');
  assert.equal(media.currentTime, 50,
    'recorded seek flow control moved the requested media time');
}

{
  const target = 819.749134;
  const video = queue(
    [{start: 819.752, end: 822}],
    [{start: 819.686, end: 822}],
  );
  const audio = queue(
    [{start: 819.7, end: 822}],
    [{start: 819.68, end: 822}],
  );
  const flow = createMsePlaybackFlowControl({
    media: {currentTime: target},
    queues: new Map([['video', video], ['audio', audio]]),
    entryKind: 'seek', entryTimeSeconds: target,
  });
  assert.deepEqual(flow.entryRange(), {start: 819.686, end: 822},
    'Chromium HEVC RAP/leading-picture buffered skew rejected exact coded A/V coverage');

  video.ranges = [{start: target + 0.051, end: 822}];
  assert.equal(flow.entryRange(), null,
    'a browser range outside the frame-boundary allowance completed a seek');

  video.ranges = [{start: target, end: 822}];
  video.committed = [{start: target + 0.000003, end: 822}];
  assert.equal(flow.entryRange(), null,
    'browser buffered data relaxed the exact committed-coded target contract');
}

{
  const target = 555.818710;
  const video = queue(
    [{start: 554.820850, end: 559.508878}],
    [
      {start: 554.8208510000001, end: 555.237934},
      {start: 555.2379400000001, end: 556.3056680000001},
      {start: 556.3056730000001, end: 557.3734010000001},
      {start: 557.373406, end: 557.907273},
      {start: 557.907279, end: 558.975006},
      {start: 558.975012, end: 559.5088790000001},
    ],
  );
  const audio = queue(
    [{start: 554.399945, end: 559.263945}],
    [{start: 554.399945, end: 559.263945}],
  );
  const flow = createMsePlaybackFlowControl({
    media: {currentTime: 0},
    queues: new Map([['video', video], ['audio', audio]]),
    entryKind: 'seek', entryTimeSeconds: target,
  });
  assert.deepEqual(flow.entryRange(), {
    start: 555.2379400000001,
    end: 556.3056680000001,
  }, 'the reported 555.818710s exact committed A/V coverage was rejected');
}

{
  const target = 758.179369;
  const video = queue(
    [{start: 756.622539, end: 761.577489}],
    [
      {start: 756.6225400000001, end: 757.039623},
      {start: 757.039629, end: 758.1073560000001},
      {start: 758.1073620000001, end: 760.242818},
      {start: 760.242823, end: 761.310551},
      {start: 761.310556, end: 761.57749},
    ],
  );
  const audio = queue(
    [{start: 756.298716, end: 761.162715}],
    [{start: 756.298716, end: 761.162716}],
  );
  const flow = createMsePlaybackFlowControl({
    media: {currentTime: 0},
    queues: new Map([['video', video], ['audio', audio]]),
    entryKind: 'seek', entryTimeSeconds: target,
  });
  assert.deepEqual(flow.entryRange(), {
    start: 758.1073620000001,
    end: 760.242818,
  }, 'the reported 758.179369s exact committed A/V coverage was rejected');
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

{
  const media = {currentTime: 0, playbackRate: 2};
  const video = queue([{start: 0, end: 30}]);
  const audio = queue([{start: 0, end: 1.5}], undefined, 5 * 1024 * 1024);
  let waits = 0;
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', video], ['audio', audio]]),
    wait: async () => { waits += 1; },
  });
  assert.equal(flow.highWatermarkSeconds(), 30,
    '2x playback did not scale the 15-second wall-clock high watermark');
  assert.equal(flow.lowWatermarkSeconds(), 16,
    '2x playback did not scale the 8-second wall-clock low watermark');
  const result = await flow.afterPush(2 * 1024 * 1024);
  assert.equal(result.commonAhead, 1.5,
    'flow control used one track ahead instead of the common A/V intersection');
  assert.equal(waits, 0,
    'the 4 MiB soft queue limit stopped input while common A/V was starved');
}

{
  const media = {currentTime: 0, playbackRate: 2};
  const video = queue([{start: 0, end: 30}]);
  const audio = queue(
    [{start: 0, end: 1.5}], undefined, 33 * 1024 * 1024,
  );
  let waits = 0;
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', video], ['audio', audio]]),
    wait: async () => {
      waits += 1;
      audio.queuedBytes = 31 * 1024 * 1024;
    },
  });
  let trimCalls = 0;
  audio.trimBefore = () => { trimCalls += 1; };
  await flow.afterPush(2 * 1024 * 1024);
  assert.equal(waits, 1,
    'the 32 MiB hard queue limit did not bound starved sequential input');
  assert.ok(trimCalls >= 2,
    'hard-pressure wait did not continue retiring the moving back buffer');
}

{
  const media = {currentTime: 15.554, playbackRate: 2};
  const video = queue([{start: 0, end: 25.254}], undefined, 33.2 * 1024 * 1024);
  const audio = queue([{start: 0, end: 25.254}]);
  let demandPumps = 0;
  video.notifyDemand = () => { demandPumps += 1; return true; };
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', video], ['audio', audio]]),
  });
  flow.notifyDemand();
  assert.equal(demandPumps, 1,
    '15.554s waiting did not kick the idle video queue with 24 pending operations');
}

{
  const media = {currentTime: 0, playbackRate: 2};
  const video = queue([{start: 0, end: 30}]);
  const audio = queue([{start: 0, end: 1.5}]);
  audio.error = new Error('audio append failed');
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', video], ['audio', audio]]),
  });
  await assert.rejects(flow.afterPush(2 * 1024 * 1024), audio.error,
    'queue errors were hidden after replacing queue-local waiters');
}

{
  const media = {currentTime: 0, playbackRate: 2};
  const video = queue([{start: 0, end: 30}], undefined, 5 * 1024 * 1024);
  const audio = queue([{start: 0, end: 30}]);
  let signalWaitStarted;
  const waitStarted = new Promise(resolve => { signalWaitStarted = resolve; });
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', video], ['audio', audio]]),
    wait: () => {
      signalWaitStarted();
      return new Promise(() => {});
    },
  });
  const pending = flow.afterPush(2 * 1024 * 1024);
  await waitStarted;
  media.currentTime = 15;
  flow.notifyDemand();
  const result = await pending;
  assert.equal(result.commonAhead, 15,
    'low-common-A/V waiting did not release a reader sleeping at the soft queue limit');
}

{
  const media = {currentTime: 0, playbackRate: 2};
  const video = queue([{start: 0, end: 30}]);
  const audio = queue([{start: 0, end: 30}]);
  const queues = new Map([['video', video], ['audio', audio]]);
  let waits = 0;
  const flow = createMsePlaybackFlowControl({
    media,
    queues,
    wait: async () => {
      waits += 1;
      media.currentTime = 14.1;
    },
  });
  await flow.afterPush(2 * 1024 * 1024);
  assert.equal(waits, 1, '2x input did not pause at 30 media seconds common A/V ahead');
  assert.ok(commonBufferedAhead(media, queues) < 16,
    '2x input resumed before common A/V fell below 16 media seconds');
}

{
  const media = {currentTime: 0, playbackRate: 1};
  const queues = new Map([
    ['video', queue([{start: 0, end: 16}])],
    ['audio', queue([{start: 0, end: 16}])],
  ]);
  let signalWaitStarted;
  const waitStarted = new Promise(resolve => { signalWaitStarted = resolve; });
  const flow = createMsePlaybackFlowControl({
    media,
    queues,
    wait: () => {
      signalWaitStarted();
      return new Promise(() => {});
    },
  });
  const pending = flow.afterPush(2 * 1024 * 1024);
  await waitStarted;
  media.playbackRate = 2;
  flow.notifyDemand();
  const result = await pending;
  assert.equal(result.commonAhead, 16,
    'ratechange wake altered the common buffered interval');
  assert.equal(flow.highWatermarkSeconds(), 30,
    'ratechange wake did not re-evaluate the dynamic 2x high watermark');
}

console.log('MSE playback flow-control tests passed');
