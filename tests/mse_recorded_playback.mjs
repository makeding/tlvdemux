import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  MSE_RECORDED_STATES,
  MSE_RECORDED_RECOVERY_FAILED,
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
                forwardBufferedSeconds = null, committed = ranges} = {}) {
  return {
    ranges, committed,
    queuedBytes,
    pendingAppends,
    pendingReconfigurations,
    updating,
    bufferedRanges() { return this.ranges; },
    committedRanges() { return this.committed; },
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
  landRecovery = null,
  recoveryPositionSeconds = null,
  media = {currentTime: 0},
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
    async reposition(offset, preserveTimeline) {
      operations.push(['reposition', offset, preserveTimeline]);
    },
    async flush() { operations.push(['flush']); },
    async finalizeIndex() { operations.push(['finalize-index']); },
    async setMsePlaybackPosition(value) { operations.push(['clock', value]); },
    async setMseRecoveryGeneration(value) { operations.push(['generation', value]); },
  };
  const queues = new Map([['video', video], ['audio', audio]]);
  const controller = createMseRecordedPlaybackController({
    source, demuxer, media, queues, initialOffset, chunkBytes,
    progressPollMilliseconds: 1, locateEntry, landRecovery,
    ...(recoveryPositionSeconds ? {recoveryPositionSeconds} : {}),
    async finalize() { operations.push(['finalize-output']); },
  });
  return {controller, source, demuxer, media, queues, video, audio, reads, operations};
}

function candidate(generation, overrides = {}) {
  return {
    type: 'recovery-candidate',
    state: 'restoring',
    episodeId: 'episode-1',
    videoTrackId: 1n,
    audioTrackId: 2n,
    sourceRapTimeUs: 20_000_000n,
    commonAvBoundaryUs: 20_100_000n,
    restartOffset: 64n,
    timestampAnchorUs: 20_100_000n,
    generation,
    exact: true,
    avState: 'stalled',
    ...overrides,
  };
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
  assert.deepEqual(operations.slice(-3), [['flush'], ['finalize-index'], ['finalize-output']],
    'true EOF did not flush, finalize the index, and drain output in order');
}

{
  const located = [];
  const {controller, operations} = fixture({
    locateEntry: async ({targetTimeSeconds, seeking}) => {
      located.push([targetTimeSeconds, seeking]);
      return seeking ? {
        nextOffset: 4n,
        bytesRead: 0n,
        requestedTimeSeconds: targetTimeSeconds,
      } : null;
    },
  });
  await controller.start();
  assert.equal(controller.state, 'ended');
  const entry = await controller.seek(79.611);
  await waitFor(() => controller.state === 'ended');
  assert.equal(entry.requestedTimeSeconds, 79.611);
  assert.deepEqual(located, [[0, false], [79.611, true]],
    'true EOF destroyed the Recorded session instead of accepting a backward seek generation');
  assert.equal(operations.filter(item => item[0] === 'finalize-output').length, 2,
    'the post-EOF seek generation did not complete on the retained Recorded controller');
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
    async locateEntry({targetTimeSeconds, seeking}) {
      located.push([targetTimeSeconds, seeking]);
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
  assert.deepEqual(located, [[0, false], [139.276545, true]],
    'Recorded controller did not distinguish initial zero from an explicit seek');
  assert.deepEqual(pushes, [], 'a late read from the cancelled supply generation reached demuxer.push');
  assert.equal(media.currentTime, 12.345,
    'Recorded controller replaced the exact user-selected MediaElement time');
}

{
  let releaseRead;
  const video = queue();
  const audio = queue();
  const {controller, media, operations} = fixture({
    size: 2n, video, audio,
    read: async (_offset, length) => {
      if (releaseRead) return new Uint8Array(Number(length));
      return new Promise(resolve => {
        releaseRead = () => resolve(new Uint8Array(Number(length)));
      });
    },
  });
  void controller.start();
  await waitFor(() => typeof releaseRead === 'function');
  controller.submitEvent(candidate(controller.generation, {
    type: 'recovery-state', state: 'held-audio',
    episodeId: 'held', avState: 'held-audio', exact: false,
  }));
  assert.deepEqual(controller.requiredTracks, ['audio'],
    'held-audio did not make Recorded supply measure its audio waterline');
  media.currentTime = 3;
  assert.equal(controller.recoveryActive, false, 'held-audio armed a recovery seek');
  controller.submitEvent(candidate(controller.generation, {
    episodeId: 'held-restored', avState: 'held-audio',
  }));
  assert.deepEqual(controller.requiredTracks, ['video', 'audio'],
    'held-audio restoration did not restore the Recorded A/V waterline');
  assert.equal(controller.recoveryActive, false,
    'held-audio restoration competed with the in-place A/V splice');
  controller.submitEvent(candidate(controller.generation, {
    type: 'recovery-state', state: 'stalled', episodeId: 'stalled',
    avState: 'stalled', exact: false, sourceRapTimeUs: 0n,
    commonAvBoundaryUs: 0n, restartOffset: 0n,
  }));
  assert.equal(controller.recoveryActive, false,
    'initial stalled evidence armed recovery without a stable exact A/V pair');
  assert.equal(operations.filter(item => item[0] === 'reposition').length, 0,
    'held-audio repositioned the recording source');
  releaseRead();
  await controller.cancel();
}

{
  let releaseRead;
  let clockWrites = 0;
  let clock = 0;
  const media = {
    get currentTime() { return clock; },
    set currentTime(value) { clockWrites += 1; clock = value; },
  };
  const video = queue({
    ranges: [{start: 10.1, end: 11}], committed: [{start: 10.1, end: 11}],
  });
  const audio = queue({
    ranges: [{start: 10.1, end: 11}], committed: [{start: 10.1, end: 11}],
  });
  const {controller, operations} = fixture({
    size: 2n, media, video, audio,
    recoveryPositionSeconds: evidence =>
      Number(evidence.commonAvBoundaryUs - 10_000_000n) / 1000000,
    read: async (_offset, length) => {
      if (releaseRead) return new Uint8Array(Number(length));
      return new Promise(resolve => {
        releaseRead = () => resolve(new Uint8Array(Number(length)));
      });
    },
  });
  void controller.start();
  await waitFor(() => typeof releaseRead === 'function');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'cached'}));
  releaseRead();
  const result = await controller.waitForRecovery();
  assert.equal(result.cacheHit, true);
  assert.equal(result.repositioned, false);
  assert.equal(clockWrites, 1, 'cached recovery did not write currentTime exactly once');
  assert.equal(clock, 10.1,
    'cached recovery wrote the source PTS instead of the mapped Recorded position');
  assert.equal(operations.filter(item => item[0] === 'reposition').length, 0,
    'cached committed/SourceBuffer intersection still repositioned the source');
  await controller.cancel();
}

{
  let releaseRead;
  let landingCalls = 0;
  let clockWrites = 0;
  let clock = 0;
  const media = {
    get currentTime() { return clock; },
    set currentTime(value) { clockWrites += 1; clock = value; },
  };
  const video = queue();
  const audio = queue();
  const {controller, operations} = fixture({
    size: 256n, media, video, audio,
    read: async (_offset, length) => {
      if (!releaseRead) {
        return new Promise(resolve => {
          releaseRead = () => resolve(new Uint8Array(Number(length)));
        });
      }
      return new Uint8Array(Number(length));
    },
    async landRecovery({
      candidate: evidence, targetTimeSeconds, source, demuxer, maxReadBytes,
    }) {
      landingCalls += 1;
      assert.equal(maxReadBytes, 64n * BigInt(MiB));
      assert.equal(evidence.restartOffset, 64n);
      assert.equal(targetTimeSeconds, 20.1);
      await source.read(evidence.restartOffset, 8n);
      await demuxer.push(new Uint8Array([1]));
      video.ranges = video.committed = [{start: 20.1, end: 21}];
      audio.ranges = audio.committed = [{start: 20.1, end: 21}];
      return {landingMode: 'exact', nextOffset: 72n};
    },
  });
  void controller.start();
  await waitFor(() => typeof releaseRead === 'function');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'landing'}));
  releaseRead();
  const result = await controller.waitForRecovery();
  assert.equal(landingCalls, 1);
  assert.equal(result.cacheHit, false);
  assert.equal(result.repositioned, true);
  assert.equal(result.bytesRead, 8n);
  assert.equal(clockWrites, 1, 'landed recovery did not write currentTime exactly once');
  assert.deepEqual(operations.filter(item => item[0] === 'reposition'),
    [['reposition', 64n, true]], 'recovery performed more than one formal reposition');
  await controller.cancel();
}

{
  let releaseRead;
  let releaseLanding;
  let clockWrites = 0;
  const media = {
    get currentTime() { return 0; },
    set currentTime(_value) { clockWrites += 1; },
  };
  const {controller} = fixture({
    size: 256n, media, video: queue(), audio: queue(),
    read: async (_offset, length) => {
      if (!releaseRead) return new Promise(resolve => {
        releaseRead = () => resolve(new Uint8Array(Number(length)));
      });
      return new Uint8Array(Number(length));
    },
    landRecovery: async () => new Promise(resolve => { releaseLanding = resolve; }),
  });
  void controller.start();
  await waitFor(() => typeof releaseRead === 'function');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'cancelled'}));
  releaseRead();
  await waitFor(() => typeof releaseLanding === 'function');
  controller.submitEvent({type: 'pause'});
  releaseLanding({landingMode: 'exact'});
  assert.equal(await controller.waitForRecovery(), null,
    'cancelled recovery callback was not fenced by generation');
  assert.equal(clockWrites, 0, 'stale recovery callback wrote currentTime');
  await controller.cancel();
}

{
  let releaseLanding;
  let clockWrites = 0;
  const media = {
    get currentTime() { return 0; },
    set currentTime(_value) { clockWrites += 1; },
  };
  const video = queue({ranges: [{start: 0, end: 16}], committed: []});
  const audio = queue({ranges: [{start: 0, end: 16}], committed: []});
  const {controller} = fixture({
    size: 256n, media, video, audio,
    locateEntry: async ({targetTimeSeconds, seeking}) => seeking
      ? {nextOffset: 256n, bytesRead: 0n, requestedTimeSeconds: targetTimeSeconds}
      : null,
    landRecovery: async () => new Promise(resolve => { releaseLanding = resolve; }),
  });
  const completion = controller.start();
  await waitFor(() => controller.state === 'draining');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'user-seek'}));
  await waitFor(() => typeof releaseLanding === 'function');
  const seek = controller.seek(7);
  releaseLanding({landingMode: 'exact'});
  const entry = await seek;
  assert.equal(entry.requestedTimeSeconds, 7);
  assert.equal(await controller.waitForRecovery(), null,
    'explicit seek did not supersede the automatic recovery generation');
  assert.equal(clockWrites, 0,
    'automatic recovery callback wrote currentTime after an explicit seek');
  await completion;
}

{
  const block = new Uint8Array(64 * MiB);
  const video = queue({ranges: [{start: 0, end: 16}], committed: []});
  const audio = queue({ranges: [{start: 0, end: 16}], committed: []});
  const {controller, operations} = fixture({
    size: 128n * BigInt(MiB), chunkBytes: 2, video, audio,
    read: async () => block,
    async landRecovery({source, candidate: evidence}) {
      await source.read(evidence.restartOffset, 64n * BigInt(MiB));
      await source.read(evidence.restartOffset + 64n * BigInt(MiB), 1n);
      return {landingMode: 'exact'};
    },
  });
  const completion = controller.start();
  await waitFor(() => controller.state === 'draining');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'exhausted'}));
  await assert.rejects(controller.waitForRecovery(), error =>
    error.code === MSE_RECORDED_RECOVERY_FAILED && error.reason === 'budget-exhausted');
  await assert.rejects(completion, error => error.code === MSE_RECORDED_RECOVERY_FAILED);
  assert.equal(controller.state, 'failed');
  assert.equal(operations.filter(item => item[0] === 'reposition').length, 1,
    '64 MiB exhaustion retried a later recovery reposition');
}

{
  const video = queue({ranges: [{start: 0, end: 16}], committed: []});
  const audio = queue({ranges: [{start: 0, end: 16}], committed: []});
  const {controller} = fixture({
    size: 256n, video, audio,
    landRecovery: async () => ({landingMode: 'held-frame', exact: true}),
  });
  const completion = controller.start();
  await waitFor(() => controller.state === 'draining');
  controller.submitEvent(candidate(controller.generation, {episodeId: 'non-exact'}));
  await assert.rejects(controller.waitForRecovery(), error =>
    error.code === MSE_RECORDED_RECOVERY_FAILED && error.reason === 'landing-not-exact');
  await assert.rejects(completion, error => error.code === MSE_RECORDED_RECOVERY_FAILED);
  assert.equal(controller.state, 'failed',
    'natural/held recovery landing did not remain an explicit failure');
}

{
  const [controllerSource, recordedSource, demoSource] = await Promise.all([
    readFile(new URL('../mse-recorded-playback.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../demo/recorded-playback.js', import.meta.url), 'utf8'),
    readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(controllerSource, /playbackRate|DEFAULT_PLAYBACK_RATE/,
    'Recorded controller changes supply policy by playback rate');
  assert.doesNotMatch(`${controllerSource}\n${recordedSource}`,
    /mse-live-transition|createLiveMseTransitionManager|candidateMediaSource/,
    'Recorded recovery imports the removed Live transition or candidate MediaSource path');
  assert.match(controllerSource,
    /candidate\.type !== 'recovery-candidate' \|\| candidate\.state !== 'restoring'/,
    'Recorded recovery no longer requires restoring evidence');
  assert.equal(controllerSource.match(/media\.currentTime\s*=/g)?.length, 1,
    'Recorded controller contains a second hidden media-clock write');
  assert.match(demoSource, /const DEFAULT_PLAYBACK_RATE = 2;/,
    'existing Recorded 2x default was changed');
  assert.match(demoSource, /liveMode \? createMsePlaybackFlowControl\(/,
    'demo no longer branches to the frozen Live flow at the input boundary');
  assert.doesNotMatch(demoSource, /createMsePlaybackFlowControl\(\{[\s\S]{0,180}entryKind:\s*liveMode/,
    'Recorded still shares the Live flow-control construction');
  assert.match(demoSource,
    /await recordedPlaybackController\.start\(startTimeSeconds\);[\s\S]{0,500}return true;/,
    'Recorded EOF no longer retains the session for a later explicit seek');
  assert.match(demoSource,
    /msePipeline\.finalize\(\{[\s\S]{0,160}endOfStream:\s*false/,
    'Recorded EOF still ends the MediaSource needed by a later explicit seek');
  assert.match(demoSource,
    /retainRecordedSession = await playSource\(/,
    'loadAndPlay does not capture the Recorded session lifetime');
  assert.match(demoSource,
    /if \(!retainRecordedSession\) \{[\s\S]{0,400}activeDemuxer\?\.delete\(\)/,
    'loadAndPlay destroys the retained Recorded demuxer after EOF');
  assert.doesNotMatch(demoSource,
    /activeRecordedPlaybackController === recordedPlaybackController[\s\S]{0,120}activeRecordedPlaybackController = null/,
    'demo still clears the Recorded controller merely because supply reached EOF');
  assert.match(demoSource, /videoFreeze\.capture\(\)/,
    'Recorded explicit seek no longer freezes the last presented frame while proving A\/V');
  assert.match(demoSource,
    /onComplete:[\s\S]{0,160}videoFreeze\.releaseAfterPresentation\(targetTimeSeconds\)/,
    'Recorded exact landing releases the stable frame before SDR presentation');
}

assert.deepEqual(MSE_RECORDED_STATES, [
  'idle', 'preparing', 'locating-entry', 'supplying', 'draining',
  'finalizing', 'ended', 'seeking', 'recovering', 'cancelled', 'failed',
]);

console.log('MSE recorded playback controller tests passed');
