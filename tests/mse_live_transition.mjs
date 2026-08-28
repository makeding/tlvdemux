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
    removed: false,
    sourceDetached: false,
    setAttribute() {},
    load() {},
    pause() {},
    removeAttribute(name) { if (name === 'src') this.sourceDetached = true; },
    remove() { this.removed = true; },
    play() { return Promise.resolve(); },
    requestVideoFrameCallback(callback) {
      queueMicrotask(() => callback(0, {mediaTime: presentedTime}));
      return 1;
    },
  };
}

const init = type => ({type, mime: `${type}/mp4`, data: new Uint8Array([1])});
const segment = type => ({
  type,
  data: new Uint8Array([2]),
  startTimeUs: 10_000_000n,
  endTimeUs: 12_000_000n,
});

{
  const commits = [];
  const revoked = [];
  const promoted = probeMedia();
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: {currentTime: 10},
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
  const commits = [];
  const manager = createLiveMseTransitionManager({
    MediaSourceClass: class {},
    media: {currentTime: 10},
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

console.log('MSE live transition tests passed');
