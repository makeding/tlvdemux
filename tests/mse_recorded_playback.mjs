import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  MSE_RECORDED_STATES,
  MSE_RECORDED_SUPPLY_FAILED,
  createMseRecordedPlaybackController,
} from '../mse-recorded-playback.mjs';

const MiB = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Timed out waiting for Recorded controller state.');
}

function queue({ranges = [], queuedBytes = 0, pendingAppends = 0,
                pendingReconfigurations = 0, updating = false,
                forwardBufferedSeconds = null} = {}) {
  return {
    ranges,
    queuedBytes,
    pendingAppends,
    pendingReconfigurations,
    updating,
    bufferedRanges() { return this.ranges; },
    snapshot() {
      return {
        state: 'running',
        updating: this.updating,
        mutationInProgress: this.updating,
        pendingMutations: this.pendingAppends + this.pendingReconfigurations,
        pendingAppends: this.pendingAppends,
        pendingReconfigurations: this.pendingReconfigurations,
        queuedBytes: this.queuedBytes,
        currentBytes: 0,
        forwardBufferedSeconds,
        buffered: this.ranges,
      };
    },
    waitIdle() { return Promise.resolve(); },
  };
}

function fixture({
  size = 4n,
  initialOffset = 0n,
  chunkBytes = 2,
  video = queue({
    ranges: [{start: 0, end: 1.1}], queuedBytes: 6 * MiB,
    pendingAppends: 1, forwardBufferedSeconds: 0.1,
  }),
  audio = queue({ranges: [{start: 0, end: 1.1}]}),
  read = null,
  push = async () => true,
  locateEntry = null,
} = {}) {
  const reads = [];
  const operations = [];
  const source = {
    size,
    async read(offset, length) {
      reads.push({offset, length});
      if (read) return read(offset, length);
      return new Uint8Array(Number(length));
    },
  };
  const demuxer = {
    async push(data) { operations.push(['push', data.byteLength]); return push(data); },
    async flush() { operations.push(['flush']); },
    async finalizeIndex() { operations.push(['finalize-index']); },
    async setMsePlaybackPosition(value) { operations.push(['clock', value]); },
  };
  const media = {currentTime: 0};
  const queues = new Map([['video', video], ['audio', audio]]);
  const controller = createMseRecordedPlaybackController({
    source, demuxer, media, queues, initialOffset, chunkBytes,
    progressPollMilliseconds: 1, locateEntry,
    async finalize() { operations.push(['end-of-stream']); },
  });
  return {controller, source, demuxer, media, queues, video, audio, reads, operations};
}

{
  const boundary = 256n * BigInt(MiB);
  const {controller, reads, operations} = fixture({
    initialOffset: boundary, size: boundary + 4n,
  });
  await controller.start();
  assert.equal(controller.state, 'ended');
  assert.deepEqual(reads.map(item => item.offset), [boundary, boundary + 2n],
    'Recorded supply stopped on the >4 MiB queue while common A/V was below resume water');
  assert.equal(controller.diagnostics().current.commonAhead, 1.1);
  assert.equal(controller.diagnostics().current.queues.video.forwardBufferedSeconds, 0.1);
  assert.deepEqual(operations.slice(-3), [['flush'], ['finalize-index'], ['end-of-stream']],
    'true EOF did not flush, finalize the index, and close MSE in order');
}

{
  const video = queue({
    ranges: [{start: 10, end: 10.1}], queuedBytes: 8 * MiB,
    pendingReconfigurations: 2,
  });
  const audio = queue({ranges: [{start: 10, end: 11.1}]});
  const {controller, reads} = fixture({video, audio});
  await controller.start();
  assert.equal(reads.length, 2,
    'consecutive 10.277733/10.811606 video reconfiguration stranded Recorded supply');
}

{
  const video = queue({ranges: [{start: 0, end: 10}], updating: true});
  const audio = queue({ranges: [{start: 0, end: 10}]});
  const {controller, reads} = fixture({video, audio});
  const completion = controller.start();
  await waitFor(() => controller.state === 'draining');
  assert.equal(reads.length, 0,
    'Recorded read above low water while SourceBuffer executed a real mutation');
  video.updating = false;
  controller.notifyUpdateEnd();
  await completion;
  assert.equal(reads.length, 2, 'updateend did not re-evaluate and resume Recorded supply');
}

{
  const video = queue({
    ranges: [{start: 0, end: 1.6}], updating: true,
    queuedBytes: 6 * MiB, pendingAppends: 4, pendingReconfigurations: 2,
  });
  const audio = queue({
    ranges: [{start: 0, end: 1.6}], queuedBytes: 6 * MiB, pendingAppends: 4,
  });
  const {controller, reads} = fixture({video, audio});
  await controller.start();
  assert.equal(reads.length, 2,
    'Recorded stopped supply below 8 seconds for mutation or queued append/reconfiguration');
}

{
  const video = queue({ranges: [{start: 0, end: 16}]});
  const audio = queue({ranges: [{start: 0, end: 16}]});
  const {controller, media, reads} = fixture({video, audio});
  const completion = controller.start();
  await waitFor(() => controller.state === 'draining');
  assert.equal(reads.length, 0, 'Recorded read above its 15 second high watermark');
  media.currentTime = 9;
  controller.notifyMediaTimeChange();
  await completion;
  assert.equal(reads.length, 2, 'Recorded supply did not resume below the 8 second watermark');
}

{
  const {controller} = fixture({push: async () => false});
  await assert.rejects(controller.start(), error => error.code === MSE_RECORDED_SUPPLY_FAILED);
  assert.equal(controller.state, 'failed');
  assert.ok(controller.diagnostics().history.length <= 64,
    'Recorded diagnostics exceeded their fixed bound');
}

{
  const {controller} = fixture({
    locateEntry: async () => { throw new Error('entry failed'); },
  });
  await assert.rejects(controller.start(), /entry failed/);
  assert.equal(controller.state, 'failed', 'Recorded entry error did not enter failed state');
}

{
  const emptyVideo = queue();
  const emptyAudio = queue();
  const boundary = 256n * BigInt(MiB);
  const chunk = new Uint8Array(2 * MiB);
  let lastReadOffset = 0n;
  const {controller, reads} = fixture({
    size: boundary + 4n * BigInt(MiB), chunkBytes: chunk.byteLength,
    video: emptyVideo, audio: emptyAudio,
    async read(offset, length) {
      lastReadOffset = offset;
      return length === BigInt(chunk.byteLength)
        ? chunk : chunk.subarray(0, Number(length));
    },
    async push() {
      if (lastReadOffset >= boundary) {
        emptyVideo.ranges = [{start: 0, end: 1.1}];
        emptyAudio.ranges = [{start: 0, end: 1.1}];
      }
      return true;
    },
  });
  await controller.start();
  assert.equal(controller.state, 'ended');
  assert.ok(reads.some(item => item.offset >= boundary),
    'Recorded startup stopped at a fixed input budget before the 256 MiB entry');
  assert.equal(controller.bytesRead, boundary + 4n * BigInt(MiB));
}

{
  let releaseRead;
  const media = {currentTime: 12.345};
  const reads = [];
  const pushes = [];
  const source = {
    size: 2n,
    async read(offset, length) {
      reads.push({offset, length});
      return new Promise(resolve => { releaseRead = () => resolve(new Uint8Array(Number(length))); });
    },
  };
  const demuxer = {
    async push(data) { pushes.push(data.byteLength); return true; },
    async flush() {},
    async finalizeIndex() {},
  };
  const queues = new Map([
    ['video', queue({ranges: [{start: 0, end: 0.1}]})],
    ['audio', queue({ranges: [{start: 0, end: 0.1}]})],
  ]);
  const located = [];
  const controller = createMseRecordedPlaybackController({
    source, demuxer, media, queues, chunkBytes: 2, progressPollMilliseconds: 1,
    async locateEntry({targetTimeSeconds}) {
      located.push(targetTimeSeconds);
      return targetTimeSeconds === 0 ? null : {nextOffset: 2n, bytesRead: 0n};
    },
  });
  void controller.start();
  await waitFor(() => reads.length === 1);
  const seek = controller.seek(139.276545);
  await waitFor(() => typeof releaseRead === 'function');
  releaseRead();
  const result = await seek;
  await waitFor(() => controller.state === 'ended');
  assert.equal(result.nextOffset, 2n);
  assert.deepEqual(located, [0, 139.276545]);
  assert.deepEqual(pushes, [], 'a late read from the cancelled supply generation reached demuxer.push');
  assert.equal(media.currentTime, 12.345,
    'Recorded controller replaced the exact user-selected MediaElement time');
}

{
  const [controllerSource, liveSource, liveTypes, demoSource] = await Promise.all([
    readFile(new URL('../mse-recorded-playback.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../mse-live-transition.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../mse-live-transition.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(controllerSource, /playbackRate|DEFAULT_PLAYBACK_RATE/,
    'Recorded controller changes supply policy by playback rate');
  assert.doesNotMatch(liveSource, /mse-recorded-playback|locating-entry|supplying|draining/,
    'Live transition imports or contains Recorded controller state');
  assert.doesNotMatch(liveTypes, /MseRecorded|locating-entry|supplying|draining/,
    'Live public API contains Recorded controller state');
  assert.match(demoSource, /const DEFAULT_PLAYBACK_RATE = 2;/,
    'existing Recorded 2x default was changed');
  assert.match(demoSource, /liveMode \? createMsePlaybackFlowControl\(/,
    'demo no longer branches to the frozen Live flow at the input boundary');
  assert.doesNotMatch(demoSource, /createMsePlaybackFlowControl\(\{[\s\S]{0,180}entryKind:\s*liveMode/,
    'Recorded still shares the Live flow-control construction');
}

assert.deepEqual(MSE_RECORDED_STATES, [
  'idle', 'preparing', 'locating-entry', 'supplying', 'draining',
  'finalizing', 'ended', 'seeking', 'cancelled', 'failed',
]);

console.log('MSE recorded playback controller tests passed');
