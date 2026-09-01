import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html, css, demo, adapter, liveTransition, recordedPlayback,
  recordedController, mediaTransaction] = await Promise.all([
  readFile(new URL('../demo/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.css', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  readFile(new URL('../demo/playback-resilience.js', import.meta.url), 'utf8'),
  readFile(new URL('../mse-live-transition.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../demo/recorded-playback.js', import.meta.url), 'utf8'),
  readFile(new URL('../mse-recorded-playback.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../demo/mse-media-transaction.js', import.meta.url), 'utf8'),
]);

assert.match(html, /id="videoRecoveryStatus" class="video-recovery-status" role="status"/,
  'demo has no stable video recovery status slot');
assert.match(css, /\.video-recovery-status\s*\{[\s\S]*position:\s*absolute;[\s\S]*min-height:\s*48px;/,
  'video recovery status can resize the surrounding player geometry');
assert.match(adapter, /TLV_VIDEO_UNAVAILABLE/,
  'audio-only status lost its stable safe error code');
assert.match(adapter, /createMsePlaybackResilienceController/,
  'demo copied resilience decisions instead of consuming the SDK controller');
assert.doesNotMatch(demo, /maximumRecoveryAttempts|attemptedRaps/,
  'demo owns or exposes internal recovery retry policy');
assert.match(demo, /BigInt\(damage\.startTimeUs \?\? damage\.endTimeUs\) - presentationStartUs/,
  'demo damage diagnostics no longer use the canonical playback-time mapping');
assert.match(demo, /映像損傷\$\{prefetched\} 再生時間/,
  'demo does not distinguish future prefetched damage from the current media clock');
assert.match(demo, /createLiveMseTransitionManager/,
  'Live fallback has no candidate MediaSource transition path');
assert.match(liveTransition, /4 \* 1024 \* 1024/,
  'Live candidate transition has no fixed byte limit');
assert.match(liveTransition, /requestVideoFrameCallback/,
  'Live A\/V candidate commits without actual presented-frame evidence');
assert.match(mediaTransaction, /candidate\.probeMedia/,
  'demo does not promote the already-buffered Live candidate MediaElement');
assert.match(liveTransition, /restoreFocus[\s\S]*focus\(\{preventScroll: true\}\)/,
  'Live candidate promotion loses MediaElement keyboard focus');
assert.match(liveTransition, /MSE detach algorithm/,
  'Live transition can regress to detaching and emptying the proven candidate');
assert.match(demo, /createMseRecordedPlaybackController/,
  'Recorded/File input does not use the independent controller');
assert.match(demo, /liveMode \? createMsePlaybackFlowControl/,
  'demo does not branch Live and Recorded flow at its input boundary');
assert.doesNotMatch(recordedPlayback, /mse-live-transition|createLiveMseTransitionManager/,
  'Recorded demo orchestration still wraps the Live transition manager');
assert.doesNotMatch(recordedController, /mse-live-transition|createMsePlaybackFlowControl/,
  'Recorded SDK controller still imports Live lifecycle decisions');
assert.ok(demo.indexOf('const gapRecovery = createDemoPlaybackResilience') <
    demo.indexOf('const observeVideoRecovery = createMseVideoRecoveryLogger'),
  'demo constructs the video-recovery logger before gapRecovery is initialized');
assert.match(recordedPlayback, /createMseRecordedSeekSession/,
  'Recorded controller entry does not reuse the public shared-budget seek API');
assert.match(demo, /activeRecordedPlaybackController\.seek\(target\)/,
  'explicit Recorded seek bypasses the active controller generation');
assert.doesNotMatch(demo, /reposition\(item\.seekResult\.nextOffset/,
  'Recorded entry performs a second reposition after formal landing');
assert.ok(demo.split('\n').length - 1 < 2000,
  'demo.js was not kept below 2000 lines after recorded-seek extraction');
const msePlaybackVersions = [demo, adapter, liveTransition, recordedPlayback]
  .flatMap(source => [...source.matchAll(/mse-playback\.mjs\?v=([^'\"]+)/g)]
    .map(match => match[1]));
assert.equal(new Set(msePlaybackVersions).size, 1,
  'the demo page loads multiple versioned instances of mse-playback');
const liveTransitionVersions = [demo, mediaTransaction]
  .flatMap(source => [...source.matchAll(/mse-live-transition\.mjs\?v=([^'\"]+)/g)]
    .map(match => match[1]));
assert.equal(new Set(liveTransitionVersions).size, 1,
  'the demo page loads multiple versioned instances of mse-live-transition');
assert.match(demo, /setIndexDuration\(presentationEndUs\)/,
  'active recording index does not retain the cached duration for candidate estimates');
assert.match(demo, /notifyPlaybackPaused/,
  'demo does not freeze resilience and candidate work on user pause');
assert.match(mediaTransaction, /waitUntilPlaybackResumed\(\)[\s\S]*mediaElement\.play\(\)/,
  'ManagedMediaSource candidate playback bypasses the user-pause gate');

console.log('demo audio-only contract tests passed');
