import assert from 'node:assert/strict';

import {
  MSE_OUTPUT_PENDING_LIMIT_BYTES,
  createMseOutputPipeline,
  setMseVideoTrackActive,
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
  if (type === 'audio') {
    audio.setTimestampOffset(-0.650638);
    audio.operations.length = 0;
  }
  const splice = type === 'audio'
    ? {presentationTimeUs: 16938688n, timestampOffsetUs: -714638n}
    : {presentationTimeUs: 10000000n, timestampOffsetUs: -1000000n};
  if (type === 'video') pipeline.onMseVideoSplice(splice);
  else pipeline.onMseAudioSplice(splice);
  pipeline.onMseInit(init(type, 3, mime));
  const mediaTiming = type === 'audio'
    ? [16938688n, 17938688n]
    : [10000000n, 11000000n];
  pipeline.onMseSegment(segment(type, 4, ...mediaTiming));
  const expectedSplice = type === 'audio'
    ? ['splice', 16.22405, -0.714638]
    : ['splice', 9, -1];
  assert.deepEqual(pipeline.queues.get(type).operations, [
    expectedSplice,
    ['init', 3, mime, true],
    ['append', 4, {
      startTimeSeconds: Number(mediaTiming[0]) / 1000000,
      endTimeSeconds: Number(mediaTiming[1]) / 1000000,
    }],
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

{
  const discarded = [];
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, mode: 'audio-only',
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
    onInactiveOutput(event) { discarded.push(event); },
  });
  pipeline.onMseSegment(segment('video', 9, 0n, 1000000n));
  pipeline.onMseInit(init('video', 8));
  pipeline.onMseInit(init('audio', 2));
  assert.deepEqual([...pipeline.queues.keys()], ['audio'],
    'audio-only pipeline waited for or installed a video SourceBuffer');
  pipeline.onMseSegment(segment('audio', 4));
  assert.deepEqual(pipeline.queues.get('audio').operations, [
    ['append', 2, null],
    ['append', 4, {startTimeSeconds: 0, endTimeSeconds: 1}],
  ]);
  assert.equal(pipeline.pendingState().discardedBytes, 2,
    'inactive video output was cached instead of bounded-discarded');
  assert.deepEqual(discarded.map(event => event.kind), ['segment', 'init']);
}

{
  const videoTrack = {selected: true};
  const videoBuffer = {videoTracks: [videoTrack]};
  const mediaSource = {sourceBuffers: [videoBuffer], activeSourceBuffers: [videoBuffer]};
  const result = await setMseVideoTrackActive({
    mediaSource, active: false,
    settle: async () => { mediaSource.activeSourceBuffers = []; },
  });
  assert.equal(result.changed, true,
    'observed activeSourceBuffers removal was not accepted');
  assert.equal(result.requiresRebuild, false);
}

{
  const videoTrack = {selected: true};
  const videoBuffer = {videoTracks: [videoTrack]};
  const mediaSource = {sourceBuffers: [videoBuffer], activeSourceBuffers: [videoBuffer]};
  const result = await setMseVideoTrackActive({
    mediaSource, active: false, settle: async () => {},
  });
  assert.equal(result.changed, false,
    'track.selected mutation was mistaken for activeSourceBuffers success');
  assert.equal(result.requiresRebuild, true);
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
  assert.equal(pipeline.queues.size, firstType === 'video' ? 2 : 0,
    `${firstType}-first startup did not wait for the first video entry boundary`);
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
  ], `${firstType}-first audio prefix was not cut at the video entry mapping`);
}

{
  const discarded = [];
  const pipeline = createMseOutputPipeline({
    mediaSource: {}, media: {}, freshRecordedEntryAlignment: true,
    recordedPresentationStartUs: 534666n,
    queueFactory(type, trackInit) { return new FakeQueue(type, trackInit); },
    onInactiveOutput(event) { discarded.push(event); },
  });
  pipeline.onMseInit(init('video', 1));
  pipeline.onMseInit(init('audio', 2));
  assert.equal(pipeline.queues.size, 0,
    'fresh Recorded startup created one or both SourceBuffers before a video boundary');
  assert.doesNotThrow(() => pipeline.onMseSegment({
    type: 'video', data: new Uint8Array(MSE_OUTPUT_PENDING_LIMIT_BYTES + 1),
    startTimeUs: 600000n, endTimeUs: 1600000n,
  }), 'the first video segment hit the wait limit before atomically installing the A/V pair');
  assert.deepEqual([...pipeline.queues.keys()], ['video', 'audio'],
    'fresh Recorded startup did not create the matched SourceBuffer pair atomically');
  assert.equal(pipeline.pendingState().segmentBytes.video, 0,
    'fresh Recorded startup accumulated initialized video outside its queue');
  assert.deepEqual(pipeline.queues.get('video').operations.slice(0, 2), [
    ['offset', -0.6],
    ['append', 1, null],
  ], 'fresh Recorded video did not map the first video boundary to zero');
  assert.deepEqual(pipeline.queues.get('audio').operations, [
    ['offset', -0.6],
    ['append', 2, null],
  ], 'fresh Recorded audio did not share the video boundary mapping');
  pipeline.onMseSegment(segment('audio', 5, 100000n, 700000n));
  pipeline.onMseSegment(segment('audio', 6, 600000n, 800000n));
  assert.deepEqual(pipeline.queues.get('audio').operations.at(-1), [
    'append', 6, {startTimeSeconds: 0.6, endTimeSeconds: 0.8},
  ], 'audio beginning at the video entry boundary was not retained');
  assert.deepEqual(discarded.map(event => event.kind), ['entry-prefix'],
    'audio wholly before the first video boundary was not discarded');
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
  assert.deepEqual(pipeline.queues.get('video').operations[0], ['offset', -0.2],
    'fresh MSE video did not map the first video boundary to zero');
  assert.deepEqual(pipeline.queues.get('audio').operations[0], ['offset', -0.2],
    'fresh MSE audio did not share the first video boundary');
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
