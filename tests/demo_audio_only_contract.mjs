import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMsePlaybackFlowControl} from '../mse-playback.mjs';

const [html, css, demo, adapter, liveTransition, recordedTransition, mediaTransaction] = await Promise.all([
  readFile(new URL('../demo/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.css', import.meta.url), 'utf8'),
  readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
  readFile(new URL('../demo/playback-resilience.js', import.meta.url), 'utf8'),
  readFile(new URL('../mse-live-transition.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../demo/recorded-mse-transition.js', import.meta.url), 'utf8'),
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
assert.match(demo, /createRecordedMseTransitionManager/,
  'recorded recovery still has no transactional candidate path');
assert.ok(demo.indexOf('const gapRecovery = createDemoPlaybackResilience') <
    demo.indexOf('const observeVideoRecovery = createMseVideoRecoveryLogger'),
  'demo constructs the video-recovery logger before gapRecovery is initialized');
assert.match(demo,
  /isActive:\s*\(\)\s*=>[\s\S]{0,160}!seekSession\s*\|\|\s*seekSession\.phase\s*===\s*'complete'/,
  'playback resilience can rewrite required tracks or the entry clock during an explicit seek');
assert.match(demo,
  /playbackEntryLocked:\s*\(\)\s*=>\s*startTimeSeconds\s*>\s*0[\s\S]{0,120}seekSession\.phase\s*!==\s*'complete'/,
  'demo does not lock the frozen explicit-seek entry before session construction');
assert.match(adapter,
  /if \(!playbackEntryLocked\(\)\)\s*\{[\s\S]{0,180}playbackFlow\(\)\.setRequiredTracks/,
  'playback resilience initial mode can replace a locked explicit-seek clock');
assert.doesNotMatch(demo, /stopPlayback\(true, false\);[\s\S]{0,120}loadAndPlay\(target/,
  'recorded recovery still destroys the old MSE before candidate validation');
assert.match(recordedTransition, /createMseRecordedSeekSession/,
  'recorded candidate does not use the shared 16 MiB seek session');
assert.match(demo, /if \(seekSession && seekSession\.phase !== 'complete'\) return;/,
  'demo can start playback before the recorded-seek fence commits');
assert.doesNotMatch(demo, /beforeLanding:[\s\S]{0,180}currentTime\s*=\s*startTimeSeconds/,
  'demo installs the requested media clock before exact A\/V landing commit');
assert.match(demo, /const result = await seekSession\.run\(\);[\s\S]{0,260}currentTime\s*=\s*startTimeSeconds;[\s\S]{0,120}maybeStartPlayback\(\);/,
  'demo does not install the frozen target and start playback after seek commit');
assert.match(demo, /playbackIntents\.isCurrent\(initialPlaybackIntent\)[\s\S]{0,100}resumePlaybackIntent\(startTimeSeconds\)/,
  'seek commit can overwrite an automatic layer intent started by native reevaluation');
assert.match(demo, /headReady:[\s\S]{0,120}selectedVideo !== null && selectedAudio !== null/,
  'recorded A\/V seek can leave head discovery before both selected tracks are ready');
assert.match(recordedTransition, /estimateOffset:\s*cachedEstimateOffset/,
  'recorded candidate does not reuse the active recording index estimate');
assert.match(recordedTransition, /adoptDemuxer/,
  'recorded candidate cannot continue sequentially from its formal landing');
assert.doesNotMatch(demo, /reposition\(item\.seekResult\.nextOffset/,
  'recorded candidate performs a second reposition after formal landing');
assert.match(mediaTransaction, /promotedMedia\.currentTime\s*=\s*target;/,
  'recorded candidate does not preserve the exact user-requested time');
assert.doesNotMatch(mediaTransaction,
  /promotedMedia\.currentTime\s*=\s*Math\.max/,
  'recorded candidate still substitutes a later buffered landing time');
assert.ok(demo.split('\n').length - 1 < 2000,
  'demo.js was not kept below 2000 lines after recorded-seek extraction');
const msePlaybackVersions = [demo, adapter, liveTransition, recordedTransition]
  .flatMap(source => [...source.matchAll(/mse-playback\.mjs\?v=([^'\"]+)/g)]
    .map(match => match[1]));
assert.equal(new Set(msePlaybackVersions).size, 1,
  'the demo page loads multiple versioned instances of mse-playback');
const liveTransitionVersions = [demo, recordedTransition, mediaTransaction]
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

{
  const executableAdapter = adapter
    .replace('../mse-playback.mjs?v=recorded-seek-entry-fence-v2',
      new URL('../mse-playback.mjs', import.meta.url).href)
    .replace('../mse-output-pipeline.mjs?v=audio-only-resilience-v1',
      new URL('../mse-output-pipeline.mjs', import.meta.url).href);
  const adapterModule = await import(
    `data:text/javascript;base64,${Buffer.from(executableAdapter).toString('base64')}`);
  const requiredTrackWrites = [];
  const target = 758.179369;
  const rangeQueue = (buffered, committed) => ({
    bufferedRanges: () => buffered,
    committedRanges: () => committed,
    trimBefore() {},
    waitFlowControlled: async () => {},
  });
  const lockedFlow = createMsePlaybackFlowControl({
    media: {currentTime: 0},
    queues: new Map([
      ['video', rangeQueue(
        [{start: 756.622539, end: 761.577489}],
        [{start: 758.1073620000001, end: 760.242818}],
      )],
      ['audio', rangeQueue(
        [{start: 756.298716, end: 761.162715}],
        [{start: 756.298716, end: 761.162716}],
      )],
    ]),
    entryKind: 'seek',
    entryTimeSeconds: target,
  });
  const controller = adapterModule.createDemoPlaybackResilience({
    media: {
      currentTime: 0, paused: true, seeking: false,
      videoFrameCallbackSupported: false,
    },
    mediaSource: () => null,
    queues: () => new Map(),
    playbackFlow: () => lockedFlow,
    pipeline: () => ({
      setRequiredTracks(tracks) { requiredTrackWrites.push({owner: 'pipeline', tracks}); },
    }),
    presentationStartUs: 0n,
    generation: 1,
    initialMode: 'audio-video',
    liveMode: false,
    isActive: () => false,
    playbackEntryLocked: () => true,
    isCurrentLayer: () => true,
    switchInFlight: () => false,
    seek() {},
    statusElement: {textContent: ''},
    playbackStateElement: {textContent: ''},
    appendLog() {},
    scheduleRecordedRebuild: async () => null,
    requestLiveTransition: async () => null,
  });
  assert.deepEqual(requiredTrackWrites, [],
    'the resilience initial callback mutated the locked seek pipeline');
  assert.equal(lockedFlow.entryTimeSeconds, target,
    'the resilience initial callback replaced the frozen explicit-seek entry clock');
  assert.deepEqual(lockedFlow.entryRange(), {
    start: 758.1073620000001,
    end: 760.242818,
  }, 'the locked 758.179369s A/V landing no longer commits');
  controller.destroy();
}

console.log('demo audio-only contract tests passed');
