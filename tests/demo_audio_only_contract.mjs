import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html, css, demo, binding, recorded, recordedController, packageJson] =
  await Promise.all([
    readFile(new URL('../demo/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../demo/demo.css', import.meta.url), 'utf8'),
    readFile(new URL('../demo/demo.js', import.meta.url), 'utf8'),
    readFile(new URL('../demo/playback-resilience.js', import.meta.url), 'utf8'),
    readFile(new URL('../demo/recorded-playback.js', import.meta.url), 'utf8'),
    readFile(new URL('../mse-recorded-playback.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
const executableBinding = binding.replace(
  /'\.\.\/mse-playback\.mjs\?v=unified-av-recovery-v1'/,
  JSON.stringify(new URL('../mse-playback.mjs', import.meta.url).href),
);
const {createDemoPlaybackResilience} = await import(
  `data:text/javascript;base64,${Buffer.from(executableBinding).toString('base64')}`,
);

assert.match(html, /id="videoRecoveryStatus" class="video-recovery-status" role="status"/,
  'demo has no stable video recovery status slot');
assert.match(css, /\.video-recovery-status\s*\{[\s\S]*position:\s*absolute;[\s\S]*min-height:\s*48px;/,
  'video recovery status can resize the surrounding player geometry');
const freezeStyle = css.match(/\.video-freeze-canvas\s*\{([^}]*)\}/)?.[1] ?? '';
assert.doesNotMatch(freezeStyle, /clip-path/,
  'Recorded seek exposes a raw-video strip below the frozen SDR presentation');
assert.match(demo, /renderedFrameSource:\s*hlgSdrRenderer/,
  'the freeze slot is not driven by completed SDR presentations');
assert.match(demo, /videoFreeze\.releaseAfterPresentation\(targetTimeSeconds\)/,
  'the seek cover is released before the landed SDR frame is presented');
assert.match(binding, /TLV_VIDEO_UNAVAILABLE/,
  'recovery status lost its stable safe error code');
assert.match(binding, /MsePlaybackMode\.HELD_AUDIO/);
assert.match(binding, /MsePlaybackMode\.STALLED/);
assert.match(binding, /MsePlaybackMode\.RESTORING/);
assert.match(binding, /onMseVideoSplice[\s\S]*onMseAudioSplice/,
  'Live restoration does not splice a matched A\/V pair');
assert.doesNotMatch(binding, /currentTime\s*=/,
  'Live recovery writes the visible media clock');
assert.match(demo, /シーク先で利用できる映像・音声の組み合わせを確認しています。/,
  'explicit Recorded seek leaves the previous layer-restoration status visible');
assert.match(demo, /シーク先の通常映像が破損しているため、対応する降雨映像・音声で再生します。/,
  'Recorded seek does not report its matched rainfall landing');
assert.doesNotMatch(binding, /\.play\s*\(|new\s+\w*MediaSource|\.reposition\s*\(|reconnect\s*\(/,
  'Live recovery exposes a forbidden playback/source capability');
assert.doesNotMatch(demo, /createLiveMseTransitionManager|commitDemoMseCandidate|openDetachedMseMedia/,
  'demo retains the candidate MediaElement\/MediaSource transition tail');
assert.doesNotMatch(packageJson, /mse-live-transition/,
  'removed Live candidate API remains in the package');
assert.match(demo, /onMseAvRecovery:\s*evidence => gapRecovery\.observeEvidence\(evidence\)/,
  'structured core evidence is not wired to the demo binding');
assert.match(demo, /createMseRecordedPlaybackController/);
assert.match(recorded, /createMseRecordedSeekSession/);
assert.match(recorded, /createRecordedRecoveryLanding/);
assert.match(recordedController, /candidate\.state !== 'restoring'/,
  'Recorded recovery is not restricted to a stable restoring candidate');
assert.match(demo, /setMseRecoveryGeneration\(BigInt\(generation\)\)/,
  'core evidence is not fenced to the playback generation');
assert.ok(demo.split('\n').length - 1 < 2000, 'demo.js exceeds 2000 lines');

{
  let visibleTime = 12.5;
  let currentTimeWrites = 0;
  let playCalls = 0;
  const media = {
    paused: false,
    get currentTime() { return visibleTime; },
    set currentTime(value) { currentTimeWrites += 1; visibleTime = value; },
    play() { playCalls += 1; return Promise.resolve(); },
  };
  const splices = [];
  const required = [];
  const offsets = [];
  const logs = [];
  const pipeline = {
    setRequiredTracks(tracks) { required.push([...tracks]); },
    onMseVideoSplice(detail) { splices.push(['video', detail]); },
    onMseAudioSplice(detail) { splices.push(['audio', detail]); },
  };
  const flow = {setRequiredTracks(tracks) { required.push([...tracks]); }};
  const recovery = createDemoPlaybackResilience({
    media, liveMode: true, generation: 7,
    isActive: () => true, pipeline: () => pipeline, playbackFlow: () => flow,
    statusElement: {textContent: ''}, playbackStateElement: {textContent: ''},
    appendLog: message => logs.push(message), submitRecordedEvent() {
      throw new Error('Live must not invoke the Recorded controller');
    },
    commitLiveTimestampOffset: offset => offsets.push(offset),
  });
  recovery.observeEvidence({
    type: 'recovery-state', state: 'stalled', avState: 'stalled',
    episodeId: 1n, generation: 7n,
  });
  recovery.observeEvidence({
    type: 'recovery-candidate', state: 'restoring', avState: 'stalled',
    episodeId: 1n, generation: 7n, exact: true,
    sourceRapTimeUs: 20000000n, commonAvBoundaryUs: 20010000n,
  });
  assert.deepEqual(splices.map(([type]) => type), ['video', 'audio'],
    'Live did not commit a matched in-place A/V splice');
  assert.equal(splices[0][1].timestampOffsetUs, -7500000n);
  assert.equal(splices[1][1].timestampOffsetUs, -7500000n);
  assert.deepEqual(offsets, [-7500000n],
    'Live did not install the same timestamp offset in its owning remuxer');
  assert.equal(currentTimeWrites, 0, 'Live recovery wrote currentTime');
  assert.equal(playCalls, 0, 'Live recovery called play()');

  recovery.notifyPlaybackPaused();
  recovery.observeEvidence({
    type: 'recovery-candidate', state: 'restoring', avState: 'stalled',
    episodeId: 2n, generation: 7n, exact: true,
    sourceRapTimeUs: 22000000n, commonAvBoundaryUs: 22000000n,
  });
  assert.equal(splices.length, 2, 'paused Live committed a recovery candidate');
  media.paused = false;
  recovery.notifyPlaybackResumed();
  assert.equal(splices.length, 4, 'resumed Live did not commit its retained candidate');
  recovery.observeEvidence({
    type: 'recovery-candidate', state: 'restoring', avState: 'stalled',
    episodeId: 3n, generation: 6n, exact: true,
    sourceRapTimeUs: 23000000n, commonAvBoundaryUs: 23000000n,
  });
  assert.equal(splices.length, 4, 'stale Live generation committed a splice');
  assert.ok(required.some(tracks => tracks.join(',') === 'video,audio'));
}

{
  const states = [];
  const recovery = createDemoPlaybackResilience({
    media: {paused: false, currentTime: 3}, liveMode: true, generation: 4,
    isActive: () => true,
    pipeline: () => ({
      onMseVideoSplice() { throw new Error('candidate queue rejected'); },
      onMseAudioSplice() { throw new Error('must not reach partial audio commit'); },
      setRequiredTracks() {},
    }),
    playbackFlow: () => ({setRequiredTracks() {}}),
    statusElement: {textContent: ''}, playbackStateElement: {textContent: ''},
    appendLog: message => states.push(message), submitRecordedEvent() {},
  });
  assert.equal(recovery.observeEvidence({
    type: 'recovery-candidate', state: 'restoring', avState: 'stalled',
    episodeId: 1n, generation: 4n, exact: true,
    sourceRapTimeUs: 5000000n, commonAvBoundaryUs: 5000000n,
  }), null, 'failed Live candidate terminated instead of returning to stalled');
  assert.equal(recovery.mode, 'stalled');
  assert.ok(states.some(message => message.includes('candidate rejected')));
}

console.log('demo unified A/V recovery contract tests passed');
