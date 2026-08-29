import assert from 'node:assert/strict';

import {MsePlaybackMode} from '../mse-playback.mjs';
import {createLiveMseTransitionManager} from '../mse-live-transition.mjs';

class FakeQueue {
  constructor(onUpdateEnd) {
    this.onUpdateEnd = onUpdateEnd;
    this.queuedBytes = 0;
    this.ranges = [];
  }
  append(_data, timing = null) {
    if (timing?.startTimeSeconds !== undefined) {
      this.ranges = [{start: timing.startTimeSeconds, end: timing.endTimeSeconds}];
    }
    this.onUpdateEnd?.();
  }
  appendInitialization() { this.onUpdateEnd?.(); }
  bufferedRanges() { return this.ranges; }
  setTimestampOffset() {}
  spliceFrom() {}
  waitStable() { return Promise.resolve(); }
  quiesce() { return Promise.resolve(); }
  destroy() {}
}

function probeMedia(presentedTime = null) {
  return {
    muted: false,
    playsInline: false,
    style: {},
    currentTime: 0,
    paused: true,
    playCount: 0,
    removed: false,
    sourceDetached: false,
    setAttribute() {},
    load() {},
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.sourceDetached = true; },
    remove() { this.removed = true; },
    play() { this.playCount += 1; this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback(callback) {
      queueMicrotask(() => callback(0, {mediaTime: presentedTime}));
      return 1;
    },
  };
}

const init = type => ({type, mime: `${type}/mp4`, data: new Uint8Array([1])});
const segment = (type, startTimeSeconds = 10, endTimeSeconds = 12) => ({
  type,
  data: new Uint8Array([2]),
  startTimeUs: BigInt(Math.round(startTimeSeconds * 1_000_000)),
  endTimeUs: BigInt(Math.round(endTimeSeconds * 1_000_000)),
});

{
  const commits = [];
  const revoked = [];
  const promoted = probeMedia();
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: {currentTime: 10, paused: false},
    isActive: () => true,
    createProbeMedia: () => promoted,
    mountProbeMedia() {},
    openMediaSource: async () => ({mediaSource: {readyState: 'open'}, url: 'audio-url'}),
    revokeObjectURL: url => revoked.push(url),
    queueFactory: (_type, _init, onUpdateEnd) => new FakeQueue(onUpdateEnd),
    commit: candidate => commits.push(candidate.mode),
    appendLog() {},
  });
  manager.observeInit(init('audio'));
  const completion = manager.transition(MsePlaybackMode.AUDIO_ONLY, 10);
  await Promise.resolve();
  manager.observeSegment(segment('audio'));
  await completion;
  assert.deepEqual(commits, [MsePlaybackMode.AUDIO_ONLY],
    'playable audio candidate was not committed');
  assert.deepEqual(revoked, [], 'committed candidate URL was revoked');
  assert.equal(promoted.sourceDetached, false,
    'committed candidate was detached and lost its SourceBuffers');
  assert.equal(promoted.removed, false,
    'committed candidate MediaElement was removed instead of promoted');
  manager.destroy();
}

{
  const oldMedia = {currentTime: 95.562112, paused: false, pauseCount: 0};
  const commits = [];
  const candidate = probeMedia();
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: oldMedia,
    isActive: () => true,
    createProbeMedia: () => candidate,
    mountProbeMedia() {},
    openMediaSource: async () => { throw new Error('candidate open failed'); },
    revokeObjectURL() {},
    commit: item => commits.push(item),
    appendLog() {},
  });
  await assert.rejects(
    manager.transition(MsePlaybackMode.AUDIO_ONLY, oldMedia.currentTime),
    /candidate open failed/,
  );
  assert.equal(oldMedia.currentTime, 95.562112,
    'candidate failure changed the old MediaSource clock');
  assert.equal(oldMedia.paused, false, 'candidate failure changed user playback intent');
  assert.deepEqual(commits, [], 'failed candidate replaced the old MediaSource');
  assert.equal(candidate.sourceDetached, true, 'failed candidate was not discarded');
  manager.destroy();
}

{
  const oldMedia = {currentTime: 95.562112, paused: false};
  const commits = [];
  const revoked = [];
  const candidate = probeMedia();
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: oldMedia,
    isActive: () => true,
    createProbeMedia: () => candidate,
    mountProbeMedia() {},
    openMediaSource: async () => ({mediaSource: {readyState: 'open'}, url: 'format-failure'}),
    revokeObjectURL: url => revoked.push(url),
    queueFactory: () => { throw new Error('candidate format failed'); },
    commit: item => commits.push(item),
    appendLog() {},
  });
  manager.observeInit(init('audio'));
  await assert.rejects(
    manager.transition(MsePlaybackMode.AUDIO_ONLY, oldMedia.currentTime),
    /candidate format failed/,
  );
  assert.equal(oldMedia.currentTime, 95.562112,
    'candidate format failure changed the old MediaSource clock');
  assert.equal(oldMedia.paused, false,
    'candidate format failure changed user playback intent');
  assert.deepEqual(commits, [], 'format-failed candidate replaced the old MediaSource');
  assert.equal(candidate.sourceDetached, true, 'format-failed candidate was not discarded');
  assert.deepEqual(revoked, ['format-failure'], 'format-failed candidate URL was not revoked');
  manager.destroy();
}

{
  const commits = [];
  const visible = {currentTime: 93.961, paused: true};
  const candidate = probeMedia(95.562112);
  let opened = 0;
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: visible,
    isActive: () => true,
    createProbeMedia: () => candidate,
    mountProbeMedia() {},
    openMediaSource: async (_MediaSourceClass, _probeMedia, {waitUntilPlaybackResumed}) => {
      await waitUntilPlaybackResumed();
      opened += 1;
      return {mediaSource: {readyState: 'open'}, url: 'paused-av'};
    },
    revokeObjectURL() {},
    queueFactory: (_type, _init, onUpdateEnd) => new FakeQueue(onUpdateEnd),
    commit: item => commits.push(item.presentedTime),
    appendLog() {},
  });
  manager.observeInit(init('video'));
  manager.observeInit(init('audio'));
  const completion = manager.transition(MsePlaybackMode.RESTORING_VIDEO, 95.562112);
  await Promise.resolve();
  manager.observeSegment(segment('video', 95.562112, 97));
  manager.observeSegment(segment('audio', 93.9, 97));
  await Promise.resolve();
  assert.equal(opened, 0, 'paused ManagedMediaSource candidate opened through hidden play');
  assert.deepEqual(commits, [], 'paused A/V restore candidate committed');
  assert.equal(candidate.playCount, 0, 'paused A/V restore candidate played');
  visible.paused = false;
  manager.notifyPlaybackResumed();
  await completion;
  assert.equal(opened, 1, 'resumed ManagedMediaSource candidate did not continue opening');
  assert.deepEqual(commits, [95.562112],
    '93.961s pause/resume did not commit the filled 95.562112s frame exactly once');
  manager.destroy();
}

{
  const commits = [];
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: {currentTime: 10, paused: false},
    isActive: () => true,
    createProbeMedia: () => probeMedia(10),
    mountProbeMedia() {},
    openMediaSource: async () => ({mediaSource: {readyState: 'open'}, url: 'av-url'}),
    revokeObjectURL() {},
    queueFactory: (_type, _init, onUpdateEnd) => new FakeQueue(onUpdateEnd),
    commit: candidate => commits.push(candidate.presentedTime),
    appendLog() {},
  });
  manager.observeInit(init('video'));
  manager.observeInit(init('audio'));
  const completion = manager.transition(MsePlaybackMode.RESTORING_VIDEO, 10);
  await Promise.resolve();
  manager.observeSegment(segment('video'));
  manager.observeSegment(segment('audio'));
  const restored = await completion;
  assert.equal(restored.presentedTime, 10,
    'A/V candidate committed without its restore RAP being presented');
  assert.deepEqual(commits, [10]);
  manager.destroy();
}

{
  const commits = [];
  const visible = {currentTime: 10, paused: true};
  const candidate = probeMedia();
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: visible,
    isActive: () => true,
    createProbeMedia: () => candidate,
    mountProbeMedia() {},
    openMediaSource: async () => ({mediaSource: {readyState: 'open'}, url: 'paused-url'}),
    revokeObjectURL() {},
    queueFactory: (_type, _init, onUpdateEnd) => new FakeQueue(onUpdateEnd),
    commit: item => commits.push(item.mode),
    appendLog() {},
  });
  manager.observeInit(init('audio'));
  const completion = manager.transition(MsePlaybackMode.AUDIO_ONLY, 10);
  await Promise.resolve();
  manager.observeSegment(segment('audio'));
  await Promise.resolve();
  assert.deepEqual(commits, [], 'paused candidate committed over the old MediaSource');
  assert.equal(candidate.playCount, 0, 'paused candidate started hidden playback');
  visible.paused = false;
  manager.notifyPlaybackResumed();
  await completion;
  assert.deepEqual(commits, [MsePlaybackMode.AUDIO_ONLY]);
  assert.equal(candidate.playCount, 1, 'resumed candidate did not continue the same transaction');
  manager.destroy();
}

console.log('MSE live transition tests passed');
