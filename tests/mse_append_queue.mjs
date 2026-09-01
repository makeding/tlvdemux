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
    this.appendLengths = [];
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
    this.appendLengths.push(data.byteLength);
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
const {createMsePlaybackFlowControl} = await import('../mse-playback.mjs');

{
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
  queue.append(new Uint8Array([1]), {startTimeSeconds: 0, endTimeSeconds: 5});
  queue.spliceFrom(0, -0.821944);
  queue.appendInitialization(new Uint8Array([2]), 'video/mp4; codecs="hvc1.2.4.L123"', true);
  queue.append(new Uint8Array([3]), {startTimeSeconds: 0.821944, endTimeSeconds: 2});
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
  assert.deepEqual(queue.committedRanges(), [{start: 0, end: 1.178056}],
    'splice/remove did not retain only the successfully appended mapped interval');
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
  const queue = new MseAppendQueue(mediaSource, media, 'audio/mp4; codecs="mp4a.40.2"');
  queue.append(new Uint8Array([1]), {startTimeSeconds: 0, endTimeSeconds: 5});
  sourceBuffer.complete();
  queue.append(new Uint8Array([2]), {startTimeSeconds: 5, endTimeSeconds: 10});
  sourceBuffer.complete();
  queue.append(new Uint8Array([3]), {startTimeSeconds: 10, endTimeSeconds: 15});
  sourceBuffer.complete();
  queue.replaceFrom(7);
  queue.appendInitialization(new Uint8Array([4]), 'audio/mp4; codecs="mp4a.40.5"');
  queue.append(new Uint8Array([5]), {startTimeSeconds: 7, endTimeSeconds: 12});

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
  assert.deepEqual(queue.committedRanges(), [{start: 0, end: 12}],
    'replaceFrom did not remove old committed media before recording replacement media');
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
  queue.setTimestampOffset(819.686);
  queue.append(new Uint8Array([1]), {startTimeSeconds: 0, endTimeSeconds: 2});
  assert.deepEqual(queue.committedRanges(), [],
    'an in-flight append was treated as committed before updateend');
  sourceBuffer.complete();
  await queue.waitIdle();
  assert.deepEqual(queue.committedRanges(), [{start: 819.686, end: 821.686}],
    'successful updateend did not commit the mapped coded interval');
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: new FakeTimeRanges()};
  const queue = new MseAppendQueue(mediaSource, media, 'audio/mp4; codecs="mp4a.40.2"');
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
  assert.deepEqual(queue.committedRanges(), [],
    'append operations without timing invented committed coded coverage');
}

for (const mime of [
  'audio/mp4; codecs="mp4a.40.2"',
  'video/mp4; codecs="hvc1.2.4.L123"',
]) {
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, mime);
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
  assert.deepEqual(queue.committedRanges(), [{
    start: 8 + (audio ? -0.714638 : -1),
    end: 9 + (audio ? -0.714638 : -1),
  }], `${mime} did not commit mapped media timing after updateend`);
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: new FakeTimeRanges()};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
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
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
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
    'queued-byte high-water mark resolved while the 5 MiB append was in flight');
  assert.deepEqual(sourceBuffer.operations, [['append', 0]],
    'a queue-local 15-second media horizon blocked append progress');

  sourceBuffer.complete();
  await controlled;
  assert.equal(resolved, true);
  await queue.waitIdle();
}

{
  const videoBuffer = new FakeSourceBuffer([[0, 30]]);
  const audioBuffer = new FakeSourceBuffer([[0, 1.5]]);
  const media = {currentTime: 0, playbackRate: 2, error: null};
  const videoQueue = new MseAppendQueue(
    new FakeMediaSource(videoBuffer), media, 'video/mp4', null,
  );
  const audioQueue = new MseAppendQueue(
    new FakeMediaSource(audioBuffer), media, 'audio/mp4', null,
  );
  audioQueue.append(new Uint8Array(5 * 1024 * 1024), {
    startTimeSeconds: 1.5,
    endTimeSeconds: 2,
  });
  const flow = createMsePlaybackFlowControl({
    media,
    queues: new Map([['video', videoQueue], ['audio', audioQueue]]),
    wait: () => new Promise(() => {}),
  });
  const pendingFlow = flow.afterPush(2 * 1024 * 1024);
  audioBuffer.complete();
  const result = await pendingFlow;
  assert.equal(result.commonAhead, 1.5);
  assert.equal(audioQueue.queuedBytes, 0,
    'strict queue watermark did not wait for the original fragment updateend');
  await audioQueue.waitIdle();
}

{
  const sourceBuffer = new FakeSourceBuffer([[0, 4]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
  queue.append(new Uint8Array(1024 * 1024).fill(1), {
    startTimeSeconds: 0, endTimeSeconds: 1,
  });
  queue.append(new Uint8Array(2 * 1024 * 1024).fill(2), {
    startTimeSeconds: 1, endTimeSeconds: 2,
  });
  let capacityReleased = false;
  const capacity = queue.waitFlowControlled(4 * 1024 * 1024).then(() => {
    capacityReleased = true;
  });
  await Promise.resolve();
  assert.equal(capacityReleased, false,
    'byte room hid the full one-active plus one-pending fragment queue');
  assert.throws(() => queue.append(new Uint8Array(2 * 1024 * 1024).fill(3), {
    startTimeSeconds: 2.2, endTimeSeconds: 3,
  }), error => error.code === 'MSE_RECORDED_SUPPLY_STALLED',
  'a track accepted more than one active and one pending original fragment');
  sourceBuffer.complete();
  await capacity;
  assert.equal(capacityReleased, true,
    'updateend did not release one original-fragment capacity slot');
  assert.deepEqual(sourceBuffer.appendLengths, [1024 * 1024, 2 * 1024 * 1024],
    'the pending original media fragment was merged or copied');
  const diagnostics = queue.diagnostics(queue.lastAppendStartedAtMilliseconds + 25);
  assert.deepEqual({
    queuedBytes: diagnostics.queuedBytes,
    currentBytes: diagnostics.currentBytes,
    pendingOperations: diagnostics.pendingOperations,
    updating: diagnostics.updating,
    currentOperation: diagnostics.currentOperation,
    updateEndCount: diagnostics.updateEndCount,
    millisecondsSinceAppendStarted: diagnostics.millisecondsSinceAppendStarted,
  }, {
    queuedBytes: 2 * 1024 * 1024,
    currentBytes: 2 * 1024 * 1024,
    pendingOperations: 0,
    updating: true,
    currentOperation: 'append',
    updateEndCount: 1,
    millisecondsSinceAppendStarted: 25,
  }, 'append diagnostics did not expose the active batched SourceBuffer operation');
  assert.ok(diagnostics.millisecondsSinceUpdateEnd >= 25,
    'append diagnostics lost the elapsed time since updateend');
  sourceBuffer.complete();
  await queue.waitIdle();
  assert.deepEqual(queue.committedRanges(), [{start: 0, end: 2}],
    'original fragment updateend did not commit its exact coded interval');
}

{
  const sourceBuffer = new FakeSourceBuffer([[17.218, 30]]);
  sourceBuffer.appendFailures.push(new DOMException('quota', 'QuotaExceededError'));
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 17.73278, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    backBufferSeconds: 8,
  });

  queue.append(new Uint8Array(1024));
  await tick();
  assert.equal(queue.error, null);
  assert.deepEqual(sourceBuffer.removeCalls, []);
  assert.equal(sourceBuffer.updating, false);
  assert.equal(queue.diagnostics().quotaBlocked, true,
    'single-fragment quota failure was not held until real reclaim progress');
  assert.equal(queue.canReclaimBackBuffer(), false,
    'quota wait incorrectly claimed unsafe history was removable');
  assert.equal(queue.quotaExceededCount, 1,
    'demand notification multiplied a quota failure without progress');
  queue.destroy();
}

{
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 0, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
  queue.append(new Uint8Array(1024).fill(1), {
    startTimeSeconds: 0, endTimeSeconds: 1,
  });
  queue.append(new Uint8Array(1024).fill(2), {
    startTimeSeconds: 1, endTimeSeconds: 2,
  });
  sourceBuffer.appendFailures.push(new DOMException('quota', 'QuotaExceededError'));
  sourceBuffer.complete();
  assert.equal(sourceBuffer.updating, false,
    'quota-pressure setup unexpectedly left SourceBuffer updating');
  assert.equal(queue.currentOperation, null,
    'quota-pressure setup unexpectedly retained a current append');
  assert.equal(queue.queue.length, 1,
    'quota-pressure setup did not retain the pending video operation');
  assert.equal(sourceBuffer.updating, false,
    'quota-blocked SourceBuffer unexpectedly began the same append again');
  assert.equal(queue.quotaExceededCount, 1,
    'playback demand spun the quota counter without state progress');
  queue.destroy();
}

{
  const sourceBuffer = new FakeSourceBuffer([[0, 20]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  const media = {currentTime: 10, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4');
  queue.append(new Uint8Array(1024 * 1024).fill(1), {
    startTimeSeconds: 20, endTimeSeconds: 21,
  });
  queue.append(new Uint8Array(2 * 1024 * 1024).fill(2), {
    startTimeSeconds: 21, endTimeSeconds: 22,
  });
  sourceBuffer.appendFailures.push(new DOMException('quota', 'QuotaExceededError'));
  sourceBuffer.complete();
  assert.equal(queue.queuedBytes, 2 * 1024 * 1024,
    'QuotaExceeded lost or duplicated the pending original fragment');
  assert.deepEqual(sourceBuffer.removeCalls.at(-1), [0, 7],
    'QuotaExceeded did not make presented-clock back-buffer room');
  sourceBuffer.complete();
  assert.equal(sourceBuffer.appendLengths.at(-1), 2 * 1024 * 1024,
    'remove completion did not retry the exact original fragment once');
  sourceBuffer.complete();
  await queue.waitIdle();
  assert.deepEqual(queue.committedRanges(), [{start: 20, end: 22}],
    'QuotaExceeded retry lost the original coded intervals');
}

{
  const sourceBuffer = new FakeSourceBuffer([[0, 30]]);
  const mediaSource = new FakeMediaSource(sourceBuffer);
  let presentedTime = 5;
  const media = {currentTime: 15.5, error: null, buffered: sourceBuffer.buffered};
  const queue = new MseAppendQueue(mediaSource, media, 'video/mp4', null, {
    backBufferSeconds: 3,
    getBackBufferReferenceTime: () => presentedTime,
  });
  queue.trimBackBuffer(true);
  assert.deepEqual(sourceBuffer.removeCalls, [[0, 2]],
    'video back-buffer trim followed the racing media clock instead of the presented frame');
  sourceBuffer.complete();
  presentedTime = 8;
  queue.trimBackBuffer(true);
  assert.deepEqual(sourceBuffer.removeCalls.at(-1), [0, 5],
    'video back-buffer trim did not advance with compositor-presented frames');
  sourceBuffer.complete();
  await queue.waitIdle();
}

{
  const removals = [];
  const mediaSource = {
    duration: 10,
    readyState: 'open',
    endOfStream() { this.readyState = 'ended'; },
  };
  const queue = end => ({
    bufferedRanges: () => [{start: 0, end}],
    removeRange: (start, finish) => removals.push([start, finish]),
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
