import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html, css, demo, adapter, liveTransition] = await Promise.all([
  readFile(new URL('../demo/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.css', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  readFile(new URL('../demo/playback-resilience.js', import.meta.url), 'utf8'),
  readFile(new URL('../mse-live-transition.mjs', import.meta.url), 'utf8'),
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
assert.match(demo, /candidate\.probeMedia/,
  'demo does not promote the already-buffered Live candidate MediaElement');
assert.match(demo, /restoreMediaFocus[\s\S]*focus\(\{preventScroll: true\}\)/,
  'Live candidate promotion loses MediaElement keyboard focus');
assert.match(liveTransition, /MSE detach algorithm/,
  'Live transition can regress to detaching and emptying the proven candidate');

console.log('demo audio-only contract tests passed');
