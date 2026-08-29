import assert from 'node:assert/strict';

import {createPlaybackIntentCoordinator}
  from '../demo/playback-intent.js';

const timers = new Map();
let timerId = 0;
const coordinator = createPlaybackIntentCoordinator({
  setTimer(callback) {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  },
  clearTimer(id) { timers.delete(id); },
});
const demuxIdentity = Object.freeze({id: 1});
const first = coordinator.begin({
  generation: 4, demuxIdentity, kind: 'explicit-seek', target: 452,
});
const committed = [];
coordinator.schedule(first, 120, token => committed.push(token.target));
const second = coordinator.begin({
  generation: 4, demuxIdentity, kind: 'explicit-seek', target: 639.288633,
});
coordinator.schedule(second, 120, token => committed.push(token.target));
assert.equal(timers.size, 1, 'superseded seek left more than one debounce timer');
for (const callback of timers.values()) callback();
assert.deepEqual(committed, [639.288633],
  'two seek intents did not commit only the last exact target');

const layer = coordinator.begin({
  generation: 4, demuxIdentity, kind: 'layer-switch', target: 639.288633,
});
const explicit = coordinator.begin({
  generation: 4, demuxIdentity, kind: 'explicit-seek', target: 697,
});
assert.equal(coordinator.isCurrent(layer), false,
  'explicit seek did not supersede a started layer switch');
await assert.rejects(coordinator.runCommit(layer, async () => {}),
  error => error.name === 'AbortError');
await coordinator.runCommit(explicit, async assertCurrent => {
  assertCurrent();
  committed.push(697);
});

const candidate = coordinator.begin({
  generation: 4, demuxIdentity, kind: 'recovery-candidate', target: 820,
});
coordinator.invalidate();
await assert.rejects(coordinator.runCommit(candidate, async () => {}),
  error => error.name === 'AbortError');

console.log('demo playback intent tests passed');
