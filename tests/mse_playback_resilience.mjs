import assert from 'node:assert/strict';

import {
  MsePlaybackMode,
  TLV_VIDEO_UNAVAILABLE,
  createMsePlaybackResilienceController,
} from '../mse-playback.mjs';

const media = (currentTime = 0) => ({
  currentTime,
  paused: false,
  seeking: false,
  playCount: 0,
  play() { this.playCount += 1; return Promise.resolve(); },
  requestVideoFrameCallback() { return 1; },
  cancelVideoFrameCallback() {},
});

const rap = (target, trackId = 2) => ({
  codec: 'hevc',
  trackId,
  randomAccess: true,
  ptsValue: Math.round(target * 1_000_000),
  ptsTimescale: 1_000_000,
});

const damage = {
  videoTrackId: 2,
  action: 'seek-if-stalled',
  severity: 'warning',
  startTimeUs: 0,
  recoveryTimeUs: 1_000_000n,
  startInputOffset: 100n,
  endInputOffset: 200n,
  recoveryInputOffset: 300n,
  recoveryRestartOffset: 250n,
};

{
  const player = media(0.5);
  const seeks = [];
  const modes = [];
  const audioOnlyRequests = [];
  const restoreRequests = [];
  const controller = createMsePlaybackResilienceController({
    media: player,
    generation: 7,
    isCurrentLayer: item => item.videoTrackId === 2,
    seek(target) { seeks.push(target); player.currentTime = target; },
    onModeChange(event) { modes.push(event); },
    onAudioOnlyRequested(event) { audioOnlyRequests.push(event); },
    onVideoRestoreRequested(event) { restoreRequests.push(event); },
  });

  controller.reportDamage(damage);
  controller.notifyWaiting();
  controller.observeAccessUnit(rap(2));
  controller.notifyWaiting();
  controller.observeAccessUnit(rap(3));
  controller.notifyWaiting();
  assert.deepEqual(seeks, [1, 2, 3],
    'the first three distinct forward RAPs were not attempted exactly once');
  assert.equal(controller.mode, MsePlaybackMode.RECOVERING_VIDEO);
  controller.notifyWaiting();
  await Promise.resolve();
  assert.equal(controller.mode, MsePlaybackMode.AUDIO_ONLY,
    'three failed forward RAP attempts did not enter audio-only');
  assert.equal(audioOnlyRequests.length, 1,
    'audio-only transition was requested more than once');
  assert.equal(audioOnlyRequests[0].code, TLV_VIDEO_UNAVAILABLE);

  controller.observeAccessUnit(rap(3));
  assert.equal(restoreRequests.length, 0,
    'an attempted or non-forward RAP was reused for restoration');
  controller.observeAccessUnit(rap(4));
  assert.equal(controller.mode, MsePlaybackMode.RESTORING_VIDEO);
  assert.equal(restoreRequests.length, 1);
  controller.notifyVideoRestoreFailed(4);
  controller.observeAccessUnit(rap(4));
  assert.equal(restoreRequests.length, 1,
    'a failed restoration RAP was attempted twice');
  controller.observeAccessUnit(rap(5));
  controller.observePresentedFrame(4.9);
  assert.equal(controller.mode, MsePlaybackMode.RESTORING_VIDEO,
    'a frame before the restore RAP committed video');
  controller.observePresentedFrame(5);
  assert.equal(controller.mode, MsePlaybackMode.AUDIO_VIDEO,
    'a presented frame at the restore RAP did not commit video');
  assert.ok(modes.some(event => event.mode === MsePlaybackMode.AUDIO_ONLY));
  controller.destroy();
}

for (const setup of ['ordinary-waiting', 'inactive-track', 'switch', 'paused']) {
  const player = media(0.5);
  const seeks = [];
  let switching = setup === 'switch';
  const controller = createMsePlaybackResilienceController({
    media: player,
    isCurrentLayer: item => setup !== 'inactive-track' && item.videoTrackId === 2,
    switchInFlight: () => switching,
    seek(target) { seeks.push(target); player.currentTime = target; },
  });
  if (setup !== 'ordinary-waiting') controller.reportDamage(damage);
  if (setup === 'paused') player.paused = true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    controller.observeAccessUnit(rap(1 + attempt));
    controller.notifyWaiting();
  }
  assert.equal(controller.mode, MsePlaybackMode.AUDIO_VIDEO,
    `${setup} incorrectly entered video recovery/audio-only`);
  assert.deepEqual(seeks, [], `${setup} incorrectly authorized a recovery seek`);
  switching = false;
  controller.destroy();
}

{
  const player = media(0.5);
  const controller = createMsePlaybackResilienceController({
    media: player,
    generation: 1,
    seek(target) { player.currentTime = target; },
  });
  controller.reportDamage(damage);
  controller.notifyWaiting();
  controller.notifyExplicitSeek(2);
  assert.equal(controller.mode, MsePlaybackMode.AUDIO_VIDEO);
  assert.equal(controller.generation, 2);
  assert.deepEqual(controller.attemptedRaps, [],
    'explicit seek retained recovery attempts from the prior generation');
  controller.destroy();
}

console.log('MSE playback resilience tests passed');
