import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html, css, demo, adapter] = await Promise.all([
  readFile(new URL('../demo/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.css', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  readFile(new URL('../demo/playback-resilience.js', import.meta.url), 'utf8'),
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

console.log('demo audio-only contract tests passed');
