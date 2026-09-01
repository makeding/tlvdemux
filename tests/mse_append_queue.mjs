import assert from 'node:assert/strict';

class FakeTimeRanges {
  constructor(ranges = []) {
    this.ranges = ranges;
  }
  get length() { return this.ranges.length; }
  start(index) { return this.ranges[index][0]; }
  end(index) { return this.ranges[index][1]; }
}

class FakeSourceBuffer extends EventTarget {
  constructor(ranges = []) {
    super();
    this.mode = 'segments';
    this.updating = false;
    this.buffered = new FakeTimeRanges(ranges);
    this.appendFailures = [];
    this.removeCalls = [];
    this.operations = [];
    this._timestampOffset = 0;
  }
  get timestampOffset() { return this._timestampOffset; }
  set timestampOffset(value) {
    this._timestampOffset = value;
    this.operations.push(['timestampOffset', value]);
  }
  appendBuffer(data) {
    const failure = this.appendFailures.shift();
    if (failure) throw failure;
    this.operations.push(['append', data[0]]);
    this.updating = true;
  }
  changeType(mime) {
    this.operations.push(['changeType', mime]);
  }
  remove(start, end) {
    if (!(end > start)) throw new TypeError(`invalid remove range ${start}..${end}`);
    this.removeCalls.push([start, end]);
    this.operations.push(['remove', start, end]);
    this.updating = true;
  }
  complete() {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported() { return true; }
  constructor(sourceBuffer) {
    super();
    this.readyState = 'open';
    this.sourceBuffers = [];
    this.sourceBuffer = sourceBuffer;
  }
  addSourceBuffer() {
    this.sourceBuffers.push(this.sourceBuffer);
    return this.sourceBuffer;
  }
}

globalThis.MediaSource = FakeMediaSource;
const {
  MseAppendQueue,
  finalizeMseMediaSource,
  nextBufferedRange,
} = await import('../mse-append-queue.mjs');

{
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    forwardBufferHighSeconds: Infinity,
  });
  queue.append(new Uint8Array([1]), {startTimeSeconds: 0, endTimeSeconds: 5});
  queue.spliceFrom(0, -0.821944);
  queue.appendInitialization(new Uint8Array([2]), 'video/mp4; codecs="hvc1.2.4.L123"', true);
  queue.append(new Uint8Array([3]), {startTimeSeconds: 0.821944, endTimeSeconds: 2});
  assert.deepEqual(queue.snapshot(), {
    state: 'running', updating: true, mutationInProgress: true,
    pendingMutations: 4, pendingAppends: 2, pendingReconfigurations: 3,
    queuedBytes: 3, currentBytes: 1, buffered: [{start: 0, end: 20}],
  }, 'queue snapshot did not expose side-effect-free Recorded drain facts');
  assert.equal(sourceBuffer.operations.length, 1, 'queue snapshot mutated SourceBuffer state');
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['remove', 0, 20]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.slice(-3), [
    ['timestampOffset', -0.821944],
    ['changeType', 'video/mp4; codecs="hvc1.2.4.L123"'],
    ['append', 2],
  ]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['append', 3]);
  assert.equal(queue.queue.at(0), undefined);
  sourceBuffer.complete();
  await queue.waitIdle();
}

{
  const ranges = [
    {start: 0, end: 307.14},
    {start: 334.37, end: 334.6},
    {start: 334.9, end: 375.63},
  ];
  assert.equal(nextBufferedRange(ranges, 306), null,
    'playback still covered by the current range must not jump');
  assert.deepEqual(nextBufferedRange(ranges, 307.14), ranges[1],
    'recording gap did not resolve to the next buffered range');
  assert.deepEqual(nextBufferedRange(ranges, 307.14, 0.5), ranges[2],
    'Live recovery accepted a range shorter than its startup buffer');
  assert.equal(nextBufferedRange(ranges, 376), null,
    'end of input incorrectly produced a recovery target');
}

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 5));
}

{
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 1, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'audio/mp4; codecs="mp4a.40.2"', null, {
    forwardBufferHighSeconds: Infinity,
  });
  queue.append(new Uint8Array([1]), {startTimeSeconds: 0, endTimeSeconds: 5});
  queue.append(new Uint8Array([2]), {startTimeSeconds: 5, endTimeSeconds: 10});
  queue.append(new Uint8Array([3]), {startTimeSeconds: 10, endTimeSeconds: 15});
  queue.replaceFrom(7);
  queue.appendInitialization(new Uint8Array([4]), 'audio/mp4; codecs="mp4a.40.5"');
  queue.append(new Uint8Array([5]), {startTimeSeconds: 7, endTimeSeconds: 12});

  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['append', 2]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['remove', 7, 20]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.slice(-2), [
    ['changeType', 'audio/mp4; codecs="mp4a.40.5"'],
    ['append', 4],
  ]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['append', 5]);
  sourceBuffer.complete();
  await queue.waitIdle();
  assert.equal(queue.queuedBytes, 0);
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: new FakeTimeRanges()};
  const queue = new MseAppendQueue(mediaSource, media, 'audio/mp4; codecs="mp4a.40.2"', null, {
    forwardBufferHighSeconds: Infinity,
  });
  queue.append(new Uint8Array([1]));
  queue.appendInitialization(new Uint8Array([2]), 'audio/mp4; codecs="mp4a.40.5"');
  queue.append(new Uint8Array([3]));

  assert.deepEqual(sourceBuffer.operations, [['append', 1]]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations, [
    ['append', 1],
    ['changeType', 'audio/mp4; codecs="mp4a.40.5"'],
    ['append', 2],
  ]);
  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.operations.at(-1), ['append', 3]);
  sourceBuffer.complete();
  await queue.waitIdle();
}

for (const mime of [
  'audio/mp4; codecs="mp4a.40.2"',
  'video/mp4; codecs="hvc1.2.4.L123"',
]) {
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, mime, null, {
    forwardBufferHighSeconds: Infinity,
  });
  queue.append(new Uint8Array([1]));
  const audio = mime.startsWith('audio/');
  if (audio) queue.setTimestampOffset(-0.650638);
  queue.spliceFrom(audio ? 16.22405 : 7, audio ? -0.714638 : -1);
  queue.appendInitialization(new Uint8Array([2]), mime, true);
  queue.append(new Uint8Array([3]), {startTimeSeconds: 8, endTimeSeconds: 9});
  for (let index = 0; index < 4; index += 1) sourceBuffer.complete();
  await queue.waitIdle();
  assert.deepEqual(sourceBuffer.operations, [
    ['append', 1],
    ...(audio ? [['timestampOffset', -0.650638]] : []),
    ['remove', audio ? 16.22405 : 7, 20],
    ['timestampOffset', audio ? -0.714638 : -1],
    ['changeType', mime],
    ['append', 2],
    ['append', 3],
  ], `${mime} splice did not preserve remove -> timestampOffset -> changeType -> init -> media`);
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: new FakeTimeRanges()};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    forwardBufferHighSeconds: Infinity,
  });
  queue.append(new Uint8Array(5 * 1024 * 1024));
  const unblocked = queue.waitBelow(4 * 1024 * 1024);

  // Model an abort/remove updateend after ownership of the previous append was
  // cleared. Subtracting currentBytes here would leave a phantom 5 MiB queued.
  queue.currentBytes = 0;
  sourceBuffer.complete();
  await unblocked;
  assert.equal(queue.queuedBytes, 0);
  assert.equal(queue.queue.length, 0);
}

{
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    forwardBufferHighSeconds: 15,
  });
  queue.append(new Uint8Array(5 * 1024 * 1024), {
    startTimeSeconds: 20,
    endTimeSeconds: 21,
  });
  let resolved = false;
  const controlled = queue.waitFlowControlled(4 * 1024 * 1024).then(() => {
    resolved = true;
  });
  await tick();
  assert.equal(resolved, false,
    'time-based forward blocking bypassed the queued-byte high-water mark');

  queue.queue[0].data = new Uint8Array(3 * 1024 * 1024);
  queue.recountQueuedBytes();
  queue.resolveWaiters();
  await controlled;
  assert.equal(resolved, true);
  queue.stop();
}

{
  const sourceBuffer = new FakeSourceBuffer([[17.218, 30]]);
  sourceBuffer.appendFailures.push(new DOMException('quota', 'QuotaExceededError'));
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 17.73278, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    backBufferSeconds: 8,
    forwardBufferHighSeconds: Infinity,
    retryDelayMilliseconds: 0,
  });

  queue.append(new Uint8Array(1024));
  await tick();
  assert.equal(queue.error, null);
  assert.deepEqual(sourceBuffer.removeCalls, []);
  assert.equal(sourceBuffer.updating, true);
  sourceBuffer.complete();
  await queue.waitIdle();
  assert.equal(queue.queuedBytes, 0);
}

{
  const removals = [];
  const mediaSource = {
    duration: 10,
    readyState: 'open',
    endOfStream() { this.readyState = 'ended'; },
  };
  const queue = end => ({
    sourceBuffer: {remove: (start, finish) => removals.push([start, finish])},
    bufferedRanges: () => [{start: 0, end}],
    waitIdle: async () => undefined,
  });
  const result = await finalizeMseMediaSource(mediaSource, [queue(10), queue(9)], {
    truncateToCommonEnd: true,
  });
  assert.deepEqual(removals, [[9, 10]]);
  assert.equal(result.truncatedTo, 9);
  assert.equal(mediaSource.duration, 9);
  assert.equal(mediaSource.readyState, 'ended');
}

console.log('mse append queue regression tests passed');
