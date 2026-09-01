import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  MSE_RECORDED_READ_BUDGET_BYTES,
  createMseRecordedPlaybackController,
} from '../mse-recorded-playback.mjs';

function queue() {
  return {
    async waitStable() {},
    bufferedRanges: () => [{start: 0, end: 30}],
    committedRanges: () => [{start: 0, end: 30}],
  };
}

const media = {currentTime: 8, playbackRate: 1};
const streamOffsets = [];
const source = {
  size: 100n,
  async read(_offset, length) { return new Uint8Array(Number(length)); },
  async *stream(offset) {
    streamOffsets.push(offset);
  },
};
const seekStates = [];
const modeSwitches = [];
const controller = createMseRecordedPlaybackController({
  source, media,
  queues: new Map([['video', queue()], ['audio', queue()]]),
  demuxer: {async push() {}},
  commonAhead: () => 2,
  switchVideoMode: async mode => {
    modeSwitches.push(mode);
    return mode === 'frozen' || mode === 'preferred';
  },
  locateSeekWindow: async options => {
    if (options.targetTimeSeconds === 8) {
      return {nextOffset: 8n, bytesRead: 0n, videoMode: 'preferred'};
    }
    assert.equal(media.currentTime, 8,
      'explicit seek probing changed currentTime before A/V commit');
    for (const state of [
      'seek-audio-anchor', 'seek-preferred', 'seek-rainfall',
      'seek-prior-frame', 'seek-commit',
    ]) {
      options.seekTransition?.(state);
      seekStates.push(state);
    }
    return {
      nextOffset: 42n,
      bytesRead: BigInt(MSE_RECORDED_READ_BUDGET_BYTES),
      videoMode: 'frozen',
    };
  },
});

await controller.start(8);
await controller.reportSourceDamage({damageStartTimeSeconds: 9});
assert.equal(controller.diagnostics().continuityState, 'frozen');
assert.equal(controller.videoMode, 'frozen');
assert.equal(media.currentTime, 8,
  'single-track ordinary damage recovery performed a hidden seek');

controller.reportVideoRecovery({
  phase: 'candidate-rejected',
  continuityState: 'preferred-candidate',
  damageStartUs: 9000000n,
  aacFrontierUs: 12000000n,
  frozenThroughUs: 12020000n,
  candidateRapUs: 11000000n,
  fallbackTrackId: null,
  lastVideoOutputEndUs: 12020000n,
});
assert.equal(controller.diagnostics().continuityState, 'frozen');
assert.equal(controller.diagnostics().frozenThrough, 12.02);

const result = await controller.seek(14);
assert.equal(result.nextOffset, 42n);
assert.equal(result.bytesRead, BigInt(MSE_RECORDED_READ_BUDGET_BYTES));
assert.equal(media.currentTime, 14,
  'explicit seek did not install the original requested target after commit');
assert.deepEqual(seekStates, [
  'seek-audio-anchor', 'seek-preferred', 'seek-rainfall',
  'seek-prior-frame', 'seek-commit',
]);
assert.equal(streamOffsets.at(-1), 42n,
  'post-seek sequential feed did not resume at committed nextOffset');

const controllerSource = await readFile(
  new URL('../mse-recorded-playback.mjs', import.meta.url), 'utf8');
const currentTimeWrites = controllerSource.match(/media\.currentTime\s*=/g) ?? [];
assert.equal(currentTimeWrites.length, 1,
  'ordinary Recorded playback gained another currentTime writer');
const demoSource = await readFile(new URL('../demo/demo.js', import.meta.url), 'utf8');
assert.match(demoSource,
  /demuxer\.switchLayer\(\s*target\.video\.trackId, selectedAudio,/,
  'rainfall fallback replaced the user-selected AAC track');
assert.doesNotMatch(demoSource, /selectedAudio\s*=\s*target\.audio\.trackId/,
  'video fallback retained a hidden AAC layer switch');

assert.deepEqual(modeSwitches, ['frozen', 'frozen'],
  'single-track damage tried to switch to a nonexistent rainfall layer');
await controller.stop();

console.log('Synthetic single-track Recorded damage flow passed');
