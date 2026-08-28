import assert from 'node:assert/strict';

import {
  MSE_OUTPUT_PENDING_LIMIT_BYTES,
  createMseOutputPipeline,
} from '../mse-output-pipeline.mjs';

class FakeQueue {
  constructor(type, init) {
    this.type = type;
    this.mime = init.mime;
    this.operations = [];
  }
  append(data, timing) { this.operations.push(['append', data[0], timing ?? null]); }
  appendInitialization(data, mime, force) {
    this.operations.push(['init', data[0], mime, force]);
    this.mime = mime;
  }
  setTimestampOffset(offset) { this.operations.push(['offset', offset]); }
  spliceFrom(boundary, offset) { this.operations.push(['splice', boundary, offset]); }
  waitStable() { return Promise.resolve(); }
}

const init = (type, byte, mime = `${type}/mp4`) => ({
  type, mime, data: new Uint8Array([byte]),
});
const segment = (type, byte, startTimeUs = 0n, endTimeUs = 1000000n) => ({
  type, data: new Uint8Array([byte]), startTimeUs, endTimeUs,
});

{
  const created = [];
  const splices = [];
  const pipeline = createMseOutputPipeline({
    mediaSource: {},
    media: {},
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
    onQueueCreated(type) { created.push(type); },
    onSplice(detail) { splices.push(detail); },
  });
  pipeline.onMseSegment(segment('video', 7));
  pipeline.onMseVideoSplice({presentationTimeUs: 821944n, timestampOffsetUs: -821944n});
  pipeline.onMseInit(init('video', 1, 'video/old'));
  assert.equal(pipeline.queues.size, 0, 'a single init created an unpaired SourceBuffer');
  pipeline.onMseInit(init('audio', 2, 'audio/mp4'));
  assert.deepEqual(created, ['video', 'audio']);
  assert.deepEqual(pipeline.queues.get('video').operations, [
    ['offset', -0.821944],
    ['append', 1, null],
  ], 'timestamp offset was not ordered before the replacement init');
  assert.deepEqual(pipeline.queues.get('audio').operations, [['append', 2, null]]);
  assert.equal(pipeline.pendingState().segmentBytes.video, 0,
    'media preceding a splice leaked into the replacement timeline');
  assert.deepEqual(splices[0], {
    type: 'video',
    sourceBoundarySeconds: 0.821944,
    outputBoundarySeconds: 0,
    timestampOffsetSeconds: -0.821944,
    detail: {presentationTimeUs: 821944n, timestampOffsetUs: -821944n},
  });
}

for (const type of ['audio', 'video']) {
  const mime = type === 'audio'
    ? 'audio/mp4; codecs="mp4a.40.2"'
    : 'video/mp4; codecs="hvc1.2.4.L123"';
  const video = new FakeQueue('video', init('video', 1,
    type === 'video' ? mime : 'video/mp4'));
  const audio = new FakeQueue('audio', init('audio', 2,
    type === 'audio' ? mime : 'audio/mp4'));
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, queues: new Map([['video', video], ['audio', audio]]),
  });
  const splice = {presentationTimeUs: 10000000n, timestampOffsetUs: -1000000n};
  if (type === 'video') pipeline.onMseVideoSplice(splice);
  else pipeline.onMseAudioSplice(splice);
  pipeline.onMseInit(init(type, 3, mime));
  pipeline.onMseSegment(segment(type, 4, 10000000n, 11000000n));
  assert.deepEqual(pipeline.queues.get(type).operations, [
    ['splice', 9, -1],
    ['init', 3, mime, true],
    ['append', 4, {startTimeSeconds: 10, endTimeSeconds: 11}],
  ], `${type} splice did not force same-MIME changeType before init and media`);
  await pipeline.waitStable();
}

{
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, pendingBytesLimit: MSE_OUTPUT_PENDING_LIMIT_BYTES,
  });
  assert.throws(() => pipeline.onMseSegment({
    type: 'video',
    data: new Uint8Array(MSE_OUTPUT_PENDING_LIMIT_BYTES + 1),
    startTimeUs: 0n,
    endTimeUs: 1n,
  }), /initialization wait limit/);
}

for (const firstType of ['video', 'audio']) {
  const secondType = firstType === 'video' ? 'audio' : 'video';
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, freshRecordedEntryAlignment: true,
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
  });
  const timing = {
    video: [166833n, 300000n],
    audio: [4875n, 260875n],
  };
  pipeline.onMseInit(init(firstType, firstType === 'video' ? 1 : 2));
  pipeline.onMseSegment(segment(firstType, firstType === 'video' ? 3 : 4,
    ...timing[firstType]));
  pipeline.onMseInit(init(secondType, secondType === 'video' ? 1 : 2));
  assert.equal(pipeline.queues.size, 0,
    `${firstType}-first startup committed before common A/V was known`);
  pipeline.onMseSegment(segment(secondType, secondType === 'video' ? 3 : 4,
    ...timing[secondType]));
  assert.deepEqual(pipeline.queues.get('video').operations, [
    ['offset', -0.166833],
    ['append', 1, null],
    ['append', 3, {startTimeSeconds: 0.166833, endTimeSeconds: 0.3}],
  ], `${firstType}-first video did not commit offset -> init -> media atomically`);
  assert.deepEqual(pipeline.queues.get('audio').operations, [
    ['offset', -0.166833],
    ['append', 2, null],
    ['append', 4, {startTimeSeconds: 0.004875, endTimeSeconds: 0.260875}],
  ], `${firstType}-first audio did not share the atomic entry mapping`);
}

{
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, freshRecordedEntryAlignment: true,
    recordedPresentationStartUs: 100000n,
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
  });
  pipeline.onMseInit(init('video', 1));
  pipeline.onMseSegment(segment('video', 3, 200000n, 1200000n));
  pipeline.onMseInit(init('audio', 2));
  pipeline.onMseSegment(segment('audio', 4, 180000n, 1200000n));
  assert.deepEqual(pipeline.queues.get('video').operations[0], ['offset', -0.1],
    'fresh MSE video did not use the union presentation start');
  assert.deepEqual(pipeline.queues.get('audio').operations[0], ['offset', -0.1],
    'fresh MSE audio did not share the union presentation start');
}

{
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, freshRecordedEntryAlignment: true,
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
  });
  pipeline.onMseVideoSplice({presentationTimeUs: 821944n, timestampOffsetUs: -821944n});
  pipeline.onMseInit(init('video', 1));
  pipeline.onMseSegment(segment('video', 3, 1000000n, 2000000n));
  pipeline.onMseInit(init('audio', 2));
  pipeline.onMseSegment(segment('audio', 4, 900000n, 2000000n));
  assert.equal(pipeline.queues.size, 0,
    'fresh entry committed before both explicit track splice offsets arrived');
  pipeline.onMseAudioSplice({presentationTimeUs: 821944n, timestampOffsetUs: -821944n});
  pipeline.onMseInit(init('audio', 2));
  pipeline.onMseSegment(segment('audio', 4, 900000n, 2000000n));
  assert.deepEqual(pipeline.queues.get('video').operations, [
    ['offset', -0.821944],
    ['append', 1, null],
    ['append', 3, {startTimeSeconds: 1, endTimeSeconds: 2}],
  ], 'fresh alignment replaced or compounded the explicit video splice offset');
  assert.deepEqual(pipeline.queues.get('audio').operations, [
    ['offset', -0.821944],
    ['append', 2, null],
    ['append', 4, {startTimeSeconds: 0.9, endTimeSeconds: 2}],
  ], 'fresh alignment replaced or compounded the explicit audio splice offset');
}

console.log('MSE output pipeline tests passed');
