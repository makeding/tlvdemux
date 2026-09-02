import assert from 'node:assert/strict';

import {createVideoFreeze} from '../demo/video-freeze.mjs';

const draws = [];
const fills = [];
const context = {
  drawImage(...args) { draws.push(args); },
  fillRect(...args) { fills.push(args); },
};
const canvas = {
  width: 0, height: 0, hidden: true,
  getContext(kind, options) {
    assert.equal(kind, '2d');
    assert.deepEqual(options, {alpha: false});
    return context;
  },
};
let frameCallback = null;
const video = {
  readyState: 4, videoWidth: 1920, videoHeight: 1080, seeking: false,
  requestVideoFrameCallback(callback) { frameCallback = callback; return 7; },
  cancelVideoFrameCallback() {},
};
const freeze = createVideoFreeze({video, canvas});

frameCallback(0, {mediaTime: 12});
video.seeking = true;
frameCallback(0, {mediaTime: 44});
video.seeking = false;
assert.equal(freeze.capture(), true);
assert.equal(freeze.active, true);
assert.equal(canvas.hidden, false);
assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
assert.deepEqual(draws[0], [video, 0, 0, 1920, 1080]);
assert.equal(draws.length, 1,
  'a target frame decoded before the seeking listener replaced the previous frame');
assert.equal(freeze.capture(), true);
assert.equal(draws.length, 1, 'a pending seek replaced its stable captured frame');
freeze.release();
assert.equal(freeze.active, false);
assert.equal(canvas.hidden, true);
frameCallback(0, {mediaTime: 44.1});
assert.equal(draws.length, 2,
  'the exact landing did not become the new remembered presentation');

const emptyCanvas = {...canvas, hidden: true};
const notReadyVideo = {...video, readyState: 1, seeking: true};
const emptyFreeze = createVideoFreeze({video: notReadyVideo, canvas: emptyCanvas});
assert.equal(emptyFreeze.capture(), true);
assert.deepEqual(fills.at(-1), [0, 0, 1920, 1080],
  'a seek before the first presented frame exposed an unproved target frame');

const filteredDraws = [];
const filteredCanvas = {width: 1280, height: 720, hidden: false};
const filteredFreezeCanvas = {
  width: 0, height: 0, hidden: true,
  getContext: () => ({
    drawImage(...args) { filteredDraws.push(args); },
    fillRect() {},
  }),
};
let filteredVideoCallback = null;
const filteredVideo = {
  readyState: 4, videoWidth: 3840, videoHeight: 2160, seeking: false,
  paused: true, currentTime: 12,
  requestVideoFrameCallback(callback) { filteredVideoCallback = callback; return 8; },
  cancelVideoFrameCallback() {},
};
const renderedListeners = new Set();
const renderedFrameSource = {
  activeCanvas: filteredCanvas,
  hasActivePresentation: true,
  onRenderedFrame(listener) {
    renderedListeners.add(listener);
    return () => renderedListeners.delete(listener);
  },
};
const filteredFreeze = createVideoFreeze({
  video: filteredVideo,
  canvas: filteredFreezeCanvas,
  renderedFrameSource,
});
for (const listener of renderedListeners) {
  listener({source: filteredCanvas, mediaTime: 12});
}
assert.deepEqual(filteredDraws[0], [filteredCanvas, 0, 0, 1280, 720],
  'the freeze slot did not retain the completed SDR presentation');
filteredVideoCallback(0, {mediaTime: 12.1});
assert.equal(filteredDraws.length, 1,
  'an independently timed raw frame replaced the completed SDR presentation');
filteredVideo.seeking = true;
assert.equal(filteredFreeze.capture(), true);
filteredVideo.currentTime = 44;
filteredVideo.seeking = false;
filteredFreeze.releaseAfterPresentation(44);
assert.equal(filteredFreeze.active, true,
  'the freeze cover released before a landed SDR presentation arrived');
for (const listener of renderedListeners) {
  listener({source: filteredCanvas, mediaTime: 44});
}
assert.equal(filteredFreeze.active, false,
  'the freeze cover remained after the landed SDR frame was presented');
assert.equal(filteredFreezeCanvas.hidden, true);
for (const listener of renderedListeners) {
  listener({source: filteredCanvas, mediaTime: 60});
}
filteredVideo.seeking = true;
assert.equal(filteredFreeze.capture(), true);
filteredVideo.seeking = false;
filteredFreeze.releaseAfterPresentation(60);
assert.equal(filteredFreeze.active, false,
  'a landed SDR presentation completed before onComplete was not recognized');
filteredFreeze.destroy();
assert.equal(renderedListeners.size, 0,
  'the SDR presentation listener survived freeze-slot destruction');

console.log('Recorded seek video freeze tests passed');
