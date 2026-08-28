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

{
  const video = new FakeQueue('video', init('video', 1, 'video/mp4'));
  const audio = new FakeQueue('audio', init('audio', 2, 'audio/mp4'));
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, queues: new Map([['video', video], ['audio', audio]]),
    forceReinitialize: () => true,
  });
  pipeline.onMseVideoSplice({presentationTimeUs: 10000000n, timestampOffsetUs: -1000000n});
  pipeline.onMseInit(init('video', 3, 'video/mp4'));
  pipeline.onMseSegment(segment('video', 4, 10000000n, 11000000n));
  assert.deepEqual(video.operations, [
    ['splice', 9, -1],
    ['init', 3, 'video/mp4', true],
    ['append', 4, {startTimeSeconds: 10, endTimeSeconds: 11}],
  ], 'splice/changeType/init/media ordering or unchanged-MIME reinitialization regressed');
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

console.log('MSE output pipeline tests passed');
