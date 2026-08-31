import {
  ENTRY_TOLERANCE_SECONDS,
} from './mse-playback-buffer.mjs';
export {
  commonCommittedRanges,
  commonBufferedAhead,
  commonBufferedRanges,
  startMsePlayback,
} from './mse-playback-buffer.mjs';
import {
  MsePlaybackMode,
  MseStartupBufferError,
  TLV_VIDEO_UNAVAILABLE,
} from './mse-playback-contract.mjs';
export {createMsePlaybackFlowControl} from './mse-playback-flow-control.mjs';
export {
  MSE_SEEK_NO_COMMON_AV,
  MSE_SEEK_READ_BUDGET_BYTES,
  MSE_STARTUP_NO_COMMON_AV,
  MsePlaybackMode,
  MseRecordedSeekError,
  MseStartupBufferError,
  TLV_VIDEO_UNAVAILABLE,
} from './mse-playback-contract.mjs';

export function createMsePlaybackDamageRecovery({
  media,
  presentationStartUs = 0n,
  observeFramesAutomatically = true,
  isActive = () => true,
  isCurrentLayer = () => true,
  switchInFlight = () => false,
  isTargetBuffered = target => {
    const ranges = media.buffered;
    if (!ranges || typeof ranges.length !== 'number') return true;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= target + ENTRY_TOLERANCE_SECONDS &&
          ranges.end(index) >= target + 0.001) return true;
    }
    return false;
  },
  seek,
}) {
  const completedDamage = new Set();
  const pendingDamage = new Map();
  const randomAccessPoints = new Map();
  const observingTracks = new Set();
  const observedRecoveryTracks = new Set();
  const frameObservationSupported = media.videoFrameCallbackSupported ??
    typeof media.requestVideoFrameCallback === 'function';
  let waitingTime = null;
  let waitingGeneration = 0;
  let lastPresentedTime = null;
  let frameCallbackId = null;
  let destroyed = false;
  let playbackPaused = Boolean(media.paused);
  const damageKey = damage => [
    damage.videoTrackId, damage.startInputOffset, damage.endInputOffset,
    damage.recoveryTimeUs, damage.recoveryInputOffset, damage.recoveryRestartOffset,
  ].map(value => String(value ?? '')).join(':');
  const trackKey = trackId => String(trackId);
  const eventTarget = event => Number(
    BigInt(event.presentationTimeUs) - BigInt(presentationStartUs),
  ) / 1000000;

  const rememberRandomAccessPoint = (trackId, target) => {
    if (!Number.isFinite(target) || target < 0) return;
    const key = trackKey(trackId);
    const points = randomAccessPoints.get(key) ?? [];
    if (!points.some(point => Math.abs(point - target) < 0.0005)) {
      points.push(target);
      points.sort((left, right) => left - right);
      if (points.length > 256) points.splice(0, points.length - 256);
      randomAccessPoints.set(key, points);
    }
  };

  const prepare = damage => {
    if ((damage.action !== 'seek' && damage.action !== 'seek-if-stalled') ||
        damage.recoveryTimeUs === null || damage.recoveryTimeUs === undefined ||
        !isActive() || !isCurrentLayer(damage) || switchInFlight()) return null;
    const target = Number(BigInt(damage.recoveryTimeUs) - BigInt(presentationStartUs)) / 1000000;
    if (!Number.isFinite(target) || target < 0) return null;
    const start = damage.startTimeUs === null || damage.startTimeUs === undefined
      ? null
      : Number(BigInt(damage.startTimeUs) - BigInt(presentationStartUs)) / 1000000;
    if (start !== null && (!Number.isFinite(start) || start < 0)) return null;
    if (damage.action === 'seek-if-stalled' &&
        (start === null || start > target)) return null;
    return {
      damage,
      key: damageKey(damage),
      target,
      start,
      action: damage.action,
      stableTargetRequired: observingTracks.has(trackKey(damage.videoTrackId)),
      stableTarget: null,
      lastAttemptedTarget: null,
      lastAttemptWaitingGeneration: null,
    };
  };

  const recover = (candidate, target = candidate?.target) => {
    const ownsInFlightSeek = candidate?.action === 'seek-if-stalled' &&
      candidate.lastAttemptedTarget !== null &&
      Math.abs(media.currentTime - candidate.lastAttemptedTarget) <= 0.1;
    if (!candidate || completedDamage.has(candidate.key) || playbackPaused ||
        !isActive() || !isCurrentLayer(candidate.damage) ||
        switchInFlight() || observingTracks.has(trackKey(candidate.damage.videoTrackId)) ||
        (candidate.stableTargetRequired && candidate.stableTarget === null) ||
        (media.seeking && !ownsInFlightSeek) || !Number.isFinite(target) ||
        target + 0.0005 < media.currentTime || !isTargetBuffered(target)) return null;
    const previousTime = media.currentTime;
    const requiresPresentedFrame = candidate.action === 'seek-if-stalled' &&
      (frameObservationSupported || lastPresentedTime !== null);
    if (requiresPresentedFrame) {
      candidate.lastAttemptedTarget = target;
      candidate.lastAttemptWaitingGeneration = waitingGeneration;
    } else {
      completedDamage.add(candidate.key);
      pendingDamage.delete(candidate.key);
    }
    waitingTime = null;
    seek(target, previousTime, {
      action: candidate.action,
      damage: candidate.damage,
      firstRecoveryTime: candidate.target,
      lastPresentedTime,
      waitingTime: previousTime,
    });
    return {start: target, end: target};
  };

  const retirePresentedDamage = () => {
    if (lastPresentedTime === null) return;
    for (const [key, candidate] of pendingDamage) {
      if (candidate.action === 'seek-if-stalled' &&
          !observingTracks.has(trackKey(candidate.damage.videoTrackId)) &&
          (!candidate.stableTargetRequired || candidate.stableTarget !== null) &&
          lastPresentedTime + 0.001 >= candidate.target) {
        completedDamage.add(key);
        pendingDamage.delete(key);
      }
    }
  };

  const recoverWaiting = () => {
    if (waitingTime === null || destroyed || playbackPaused || !isActive() ||
        switchInFlight()) return null;
    const currentTime = media.currentTime;
    const candidates = [...pendingDamage.values()]
      .filter(candidate => candidate.action === 'seek-if-stalled' &&
        !completedDamage.has(candidate.key) && isCurrentLayer(candidate.damage) &&
        candidate.start !== null && candidate.start <= currentTime + 0.1 &&
        candidate.lastAttemptWaitingGeneration !== waitingGeneration &&
        (lastPresentedTime === null || lastPresentedTime + 0.001 < candidate.target))
      .sort((left, right) => right.target - left.target);
    for (const candidate of candidates) {
      if (!frameObservationSupported && lastPresentedTime === null &&
          currentTime > candidate.target + 0.001) {
        pendingDamage.delete(candidate.key);
        continue;
      }
      const minimumTarget = Math.max(currentTime, candidate.target);
      const target = (randomAccessPoints.get(trackKey(candidate.damage.videoTrackId)) ?? [])
        .find(point => point + 0.0005 >= minimumTarget &&
          (candidate.lastAttemptedTarget === null ||
            point > candidate.lastAttemptedTarget + 0.0005) &&
          isTargetBuffered(point));
      if (target !== undefined) return recover(candidate, target);
    }
    return null;
  };

  const observePresentedFrame = mediaTime => {
    if (destroyed || playbackPaused || !Number.isFinite(mediaTime)) return null;
    lastPresentedTime = lastPresentedTime === null
      ? mediaTime : Math.max(lastPresentedTime, mediaTime);
    retirePresentedDamage();
    if (waitingTime !== null && mediaTime + 0.001 >= waitingTime) waitingTime = null;
    return lastPresentedTime;
  };

  const scheduleFrameObservation = () => {
    if (destroyed || !frameObservationSupported) return;
    frameCallbackId = media.requestVideoFrameCallback((_now, metadata) => {
      frameCallbackId = null;
      observePresentedFrame(Number(metadata?.mediaTime));
      scheduleFrameObservation();
    });
  };
  if (observeFramesAutomatically) scheduleFrameObservation();

  const observeVideoRecoveryEvent = event => {
    if (destroyed || !event || !isCurrentLayer({videoTrackId: event.videoTrackId})) return null;
    const key = trackKey(event.videoTrackId);
    observedRecoveryTracks.add(key);
    if (event.phase === 'observation-started' || event.phase === 'candidate-rejected') {
      observingTracks.add(key);
      for (const candidate of pendingDamage.values()) {
        if (trackKey(candidate.damage.videoTrackId) !== key) continue;
        candidate.stableTargetRequired = true;
        candidate.stableTarget = null;
      }
      return null;
    }
    if (event.phase !== 'stable-rap-committed') return null;
    const target = eventTarget(event);
    if (!Number.isFinite(target) || target < 0) return null;
    observingTracks.delete(key);
    rememberRandomAccessPoint(event.videoTrackId, target);
    for (const candidate of pendingDamage.values()) {
      if (trackKey(candidate.damage.videoTrackId) !== key) continue;
      candidate.stableTargetRequired = true;
      candidate.stableTarget = target;
      candidate.target = target;
    }
    retirePresentedDamage();
    return recoverWaiting();
  };

  return {
    notifyWaiting() {
      const currentTime = media.currentTime;
      if (playbackPaused || !isActive() || switchInFlight()) {
        waitingTime = null;
        return null;
      }
      waitingTime = currentTime;
      waitingGeneration += 1;
      for (const [key, item] of pendingDamage) {
        if (completedDamage.has(key) || !isCurrentLayer(item.damage)) {
          pendingDamage.delete(key);
        }
      }
      const shortRecovery = recoverWaiting();
      if (shortRecovery) return shortRecovery;
      const severe = [...pendingDamage.values()]
        .filter(item => item.action === 'seek' &&
          (item.start === null || item.start <= currentTime + 0.1))
        .sort((left, right) => left.target - right.target)[0] ?? null;
      return recover(severe);
    },
    notifyBufferedChange() {
      if (playbackPaused) return null;
      return recoverWaiting();
    },
    observeAccessUnit(unit) {
      if (destroyed || unit?.codec !== 'hevc' || !unit.randomAccess ||
          unit.ptsValue === null || unit.ptsValue === undefined ||
          !Number.isFinite(Number(unit.ptsTimescale)) || Number(unit.ptsTimescale) <= 0) return null;
      const sourceSeconds = Number(unit.ptsValue) / Number(unit.ptsTimescale);
      const target = sourceSeconds - Number(BigInt(presentationStartUs)) / 1000000;
      if (observingTracks.has(trackKey(unit.trackId))) return null;
      rememberRandomAccessPoint(unit.trackId, target);
      if (playbackPaused) return null;
      return recoverWaiting();
    },
    observeVideoRecoveryEvent,
    observePresentedFrame,
    destroy() {
      destroyed = true;
      if (frameCallbackId !== null && typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = null;
      completedDamage.clear();
      pendingDamage.clear();
      randomAccessPoints.clear();
      observingTracks.clear();
      observedRecoveryTracks.clear();
      playbackPaused = false;
      waitingTime = null;
      waitingGeneration = 0;
      lastPresentedTime = null;
    },
    reset() {
      completedDamage.clear();
      pendingDamage.clear();
      observingTracks.clear();
      observedRecoveryTracks.clear();
      waitingTime = null;
      waitingGeneration = 0;
      lastPresentedTime = null;
    },
    reportDamage(damage) {
      const candidate = prepare(damage);
      if (!candidate || completedDamage.has(candidate.key)) return null;
      const existing = pendingDamage.get(candidate.key);
      if (existing) return existing.action === 'seek-if-stalled'
        ? recoverWaiting() : null;
      const track = trackKey(damage.videoTrackId);
      const episode = [...pendingDamage.values()].find(item =>
        trackKey(item.damage.videoTrackId) === track &&
        (observingTracks.has(track) || item.stableTargetRequired));
      if (episode) {
        episode.stableTargetRequired = true;
        episode.stableTarget = null;
        return episode.action === 'seek-if-stalled' ? recoverWaiting() : null;
      }
      pendingDamage.set(candidate.key, candidate);
      if (!candidate.stableTargetRequired) {
        rememberRandomAccessPoint(damage.videoTrackId, candidate.target);
      }
      if (candidate.action === 'seek-if-stalled') {
        retirePresentedDamage();
        return recoverWaiting();
      }
      if (candidate.target < media.currentTime) return null;
      if (candidate.start === null || media.currentTime + 0.1 < candidate.start) return null;
      return recover(candidate);
    },
    notifyPlaybackPaused() {
      playbackPaused = true;
      waitingTime = null;
    },
    notifyPlaybackResumed() {
      playbackPaused = false;
    },
  };
}

/**
 * Owns the selected-video recovery lifecycle while delegating each legal seek
 * decision to createMsePlaybackDamageRecovery(). Consumers only perform the
 * requested MSE transition and render the structured mode changes.
 */
export function createMsePlaybackResilienceController({
  media,
  presentationStartUs = 0n,
  generation = 0,
  initialMode = MsePlaybackMode.AUDIO_VIDEO,
  initialRestoreTarget = null,
  maximumRecoveryAttempts = 3,
  isActive = () => true,
  isCurrentLayer = () => true,
  switchInFlight = () => false,
  isTargetBuffered,
  seek,
  onModeChange = () => {},
  onAudioOnlyRequested = () => {},
  onVideoRestoreRequested = () => {},
  onVideoRestored = () => {},
}) {
  if (!Number.isInteger(maximumRecoveryAttempts) || maximumRecoveryAttempts < 1) {
    throw new TypeError('maximumRecoveryAttempts must be a positive integer.');
  }
  if (initialMode !== MsePlaybackMode.AUDIO_VIDEO &&
      initialMode !== MsePlaybackMode.AUDIO_ONLY &&
      initialMode !== MsePlaybackMode.RESTORING_VIDEO) {
    throw new TypeError('initialMode must be audio-video, audio-only, or restoring-video.');
  }
  if (initialMode === MsePlaybackMode.RESTORING_VIDEO &&
      (!Number.isFinite(initialRestoreTarget) || initialRestoreTarget < 0)) {
    throw new TypeError('initialRestoreTarget is required for restoring-video.');
  }
  let currentGeneration = generation;
  let mode = initialMode;
  let destroyed = false;
  let sourceEnded = false;
  let attempts = [];
  let lastPresentedTime = null;
  let restoreTarget = initialMode === MsePlaybackMode.RESTORING_VIDEO
    ? initialRestoreTarget : null;
  let lastRestoreTarget = restoreTarget;
  let recoveryObservationSeen = false;
  let stableRecoveryTarget = null;
  let frameCallbackId = null;
  let playbackPaused = Boolean(media.paused);

  const modeDetail = detail => {
    const event = {
      mode,
      generation: currentGeneration,
      code: mode === MsePlaybackMode.AUDIO_ONLY || mode === MsePlaybackMode.RESTORING_VIDEO
        ? TLV_VIDEO_UNAVAILABLE : null,
      ...detail,
    };
    if ((mode === MsePlaybackMode.RECOVERING_VIDEO ||
         mode === MsePlaybackMode.RESTORING_VIDEO) &&
        (!Number.isFinite(event.target) || event.target < 0)) {
      throw new TypeError(`${mode} mode events require a finite target.`);
    }
    return event;
  };
  const setMode = (nextMode, detail = {}) => {
    if (destroyed || mode === nextMode) return modeDetail(detail);
    const previousMode = mode;
    mode = nextMode;
    const event = modeDetail({previousMode, ...detail});
    onModeChange(event);
    return event;
  };
  const usable = () => !destroyed && !sourceEnded && isActive();
  const unitTarget = unit => {
    if (unit?.codec !== 'hevc' || !unit.randomAccess ||
        unit.ptsValue === null || unit.ptsValue === undefined ||
        !Number.isFinite(Number(unit.ptsTimescale)) || Number(unit.ptsTimescale) <= 0) return null;
    const sourceSeconds = Number(unit.ptsValue) / Number(unit.ptsTimescale);
    const target = sourceSeconds - Number(BigInt(presentationStartUs)) / 1000000;
    return Number.isFinite(target) && target >= 0 ? target : null;
  };
  const resetState = ({nextGeneration = currentGeneration, reason = 'reset'} = {}) => {
    currentGeneration = nextGeneration;
    sourceEnded = false;
    attempts = [];
    restoreTarget = null;
    lastRestoreTarget = null;
    lastPresentedTime = null;
    recoveryObservationSeen = false;
    stableRecoveryTarget = null;
    damageRecovery.reset();
    return setMode(MsePlaybackMode.AUDIO_VIDEO, {reason});
  };

  const damageRecovery = createMsePlaybackDamageRecovery({
    media,
    presentationStartUs,
    observeFramesAutomatically: false,
    isActive: usable,
    isCurrentLayer,
    switchInFlight,
    isTargetBuffered,
    seek(target, previousTime, detail) {
      if (!usable() || playbackPaused) return;
      const previousAttempt = attempts.at(-1);
      if (!previousAttempt || target > previousAttempt.target + 0.0005) {
        attempts.push({target, presentedBefore: lastPresentedTime});
      }
      setMode(MsePlaybackMode.RECOVERING_VIDEO, {
        reason: 'recovery-rap', target, damage: detail.damage,
      });
      seek(target, previousTime, detail);
    },
  });

  const enterAudioOnly = reason => {
    if (mode === MsePlaybackMode.AUDIO_ONLY || !usable()) return null;
    const event = setMode(MsePlaybackMode.AUDIO_ONLY, {
      reason,
      attemptedRaps: attempts.map(item => item.target),
    });
    restoreTarget = null;
    Promise.resolve(onAudioOnlyRequested(event)).catch(() => {});
    return event;
  };

  const observePresentedFrame = mediaTime => {
    if (!usable() || playbackPaused || !Number.isFinite(mediaTime)) return null;
    lastPresentedTime = lastPresentedTime === null
      ? mediaTime : Math.max(lastPresentedTime, mediaTime);
    damageRecovery.observePresentedFrame(mediaTime);
    const currentAttempt = attempts.at(-1);
    const recoveryCompletionTarget = recoveryObservationSeen
      ? stableRecoveryTarget : currentAttempt?.target ?? null;
    if (mode === MsePlaybackMode.RECOVERING_VIDEO && currentAttempt &&
        recoveryCompletionTarget !== null &&
        lastPresentedTime + 0.001 >= recoveryCompletionTarget) {
      attempts = [];
      recoveryObservationSeen = false;
      stableRecoveryTarget = null;
      setMode(MsePlaybackMode.AUDIO_VIDEO, {
        reason: 'video-presented', mediaTime: lastPresentedTime,
      });
    } else if (mode === MsePlaybackMode.RESTORING_VIDEO && restoreTarget !== null &&
        lastPresentedTime + 0.001 >= restoreTarget) {
      const restoredTarget = restoreTarget;
      restoreTarget = null;
      attempts = [];
      const event = setMode(MsePlaybackMode.AUDIO_VIDEO, {
        reason: 'video-restored', target: restoredTarget, mediaTime: lastPresentedTime,
      });
      onVideoRestored(event);
    }
    return lastPresentedTime;
  };

  const frameObservationSupported = media.videoFrameCallbackSupported ??
    typeof media.requestVideoFrameCallback === 'function';
  const scheduleFrameObservation = () => {
    if (destroyed || !frameObservationSupported) return;
    frameCallbackId = media.requestVideoFrameCallback((_now, metadata) => {
      frameCallbackId = null;
      observePresentedFrame(Number(metadata?.mediaTime));
      scheduleFrameObservation();
    });
  };
  onModeChange(modeDetail({
    reason: 'initial',
    ...(mode === MsePlaybackMode.RESTORING_VIDEO ? {target: restoreTarget} : {}),
  }));
  scheduleFrameObservation();

  const notifyVideoRestoreFailed = (
    target = restoreTarget, reason = 'restore-candidate-failed',
  ) => {
    if (playbackPaused || mode !== MsePlaybackMode.RESTORING_VIDEO || target === null ||
        Math.abs(target - restoreTarget) > 0.0005) return null;
    restoreTarget = null;
    const event = setMode(MsePlaybackMode.AUDIO_ONLY, {reason, target});
    Promise.resolve(onAudioOnlyRequested(event)).catch(() => {});
    return event;
  };

  return {
    get mode() { return mode; },
    get generation() { return currentGeneration; },
    get attemptedRaps() { return attempts.map(item => item.target); },
    get lastPresentedTime() { return lastPresentedTime; },
    get videoFrameObservationSupported() { return frameObservationSupported; },
    reportDamage(damage) {
      if (!usable() || mode === MsePlaybackMode.AUDIO_ONLY ||
          mode === MsePlaybackMode.RESTORING_VIDEO) return null;
      return damageRecovery.reportDamage(damage);
    },
    notifyWaiting() {
      if (!usable() || playbackPaused || media.paused || switchInFlight()) return null;
      if (mode === MsePlaybackMode.RESTORING_VIDEO && restoreTarget !== null &&
          (lastPresentedTime === null || lastPresentedTime + 0.001 < restoreTarget)) {
        return notifyVideoRestoreFailed(restoreTarget, 'restore-candidate-stalled');
      }
      const currentAttempt = attempts.at(-1);
      if (mode === MsePlaybackMode.RECOVERING_VIDEO &&
          attempts.length >= maximumRecoveryAttempts && currentAttempt &&
          (lastPresentedTime === null || lastPresentedTime + 0.001 < currentAttempt.target)) {
        return enterAudioOnly('recovery-attempts-exhausted');
      }
      if (mode === MsePlaybackMode.AUDIO_ONLY || mode === MsePlaybackMode.RESTORING_VIDEO) {
        return null;
      }
      return damageRecovery.notifyWaiting();
    },
    notifyBufferedChange() {
      if (!usable() || playbackPaused || mode === MsePlaybackMode.AUDIO_ONLY ||
          mode === MsePlaybackMode.RESTORING_VIDEO) return null;
      return damageRecovery.notifyBufferedChange();
    },
    observeAccessUnit(unit) {
      if (!usable()) return null;
      const target = unitTarget(unit);
      if (target === null || !isCurrentLayer({videoTrackId: unit.trackId})) return null;
      if (mode !== MsePlaybackMode.AUDIO_ONLY) {
        if (mode === MsePlaybackMode.RESTORING_VIDEO) return null;
        return damageRecovery.observeAccessUnit(unit);
      }
      if (recoveryObservationSeen && stableRecoveryTarget === null) return null;
      if (playbackPaused || media.paused || switchInFlight() ||
          target <= media.currentTime + 0.0005 ||
          (lastRestoreTarget !== null && target <= lastRestoreTarget + 0.0005)) return null;
      restoreTarget = target;
      lastRestoreTarget = target;
      const event = setMode(MsePlaybackMode.RESTORING_VIDEO, {
        reason: 'future-recovery-rap', target, unit,
      });
      Promise.resolve(onVideoRestoreRequested(event)).catch(() => {
        if (!destroyed && mode === MsePlaybackMode.RESTORING_VIDEO && restoreTarget === target) {
          notifyVideoRestoreFailed(target, 'restore-request-failed');
        }
      });
      return event;
    },
    observeVideoRecoveryEvent(event) {
      if (!usable() || !isCurrentLayer({videoTrackId: event?.videoTrackId})) return null;
      if (event.phase === 'observation-started' || event.phase === 'candidate-rejected') {
        recoveryObservationSeen = true;
        stableRecoveryTarget = null;
      } else if (event.phase === 'stable-rap-committed') {
        recoveryObservationSeen = true;
        stableRecoveryTarget = Number(
          BigInt(event.presentationTimeUs) - BigInt(presentationStartUs),
        ) / 1000000;
      }
      return damageRecovery.observeVideoRecoveryEvent(event);
    },
    observePresentedFrame,
    notifyVideoRestoreFailed,
    notifyPlaybackPaused() {
      if (destroyed || playbackPaused) return;
      playbackPaused = true;
      damageRecovery.notifyPlaybackPaused();
    },
    notifyPlaybackResumed() {
      if (destroyed || !playbackPaused) return;
      playbackPaused = false;
      damageRecovery.notifyPlaybackResumed();
    },
    notifyMediaElementChanged() {
      if (frameCallbackId !== null &&
          typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = null;
      scheduleFrameObservation();
    },
    notifyExplicitSeek(nextGeneration = currentGeneration) {
      return resetState({nextGeneration, reason: 'explicit-seek'});
    },
    notifyTrackSwitch(nextGeneration = currentGeneration) {
      return resetState({nextGeneration, reason: 'track-switch'});
    },
    reset(nextGeneration = currentGeneration) {
      return resetState({nextGeneration, reason: 'generation-reset'});
    },
    notifySourceEnded() {
      sourceEnded = true;
      attempts = [];
      restoreTarget = null;
      recoveryObservationSeen = false;
      stableRecoveryTarget = null;
      damageRecovery.reset();
      return setMode(MsePlaybackMode.AUDIO_VIDEO, {reason: 'source-ended'});
    },
    destroy() {
      destroyed = true;
      damageRecovery.destroy();
      if (frameCallbackId !== null && typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = null;
      attempts = [];
      restoreTarget = null;
      playbackPaused = false;
    },
  };
}

function playbackIntentSupersededError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Playback intent superseded.', 'AbortError');
  }
  const error = new Error('Playback intent superseded.');
  error.name = 'AbortError';
  return error;
}

export function createMsePlaybackIntentCoordinator({
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  let serial = 0;
  let current = null;
  let scheduled = null;
  let commitLane = Promise.resolve();

  const cancelScheduled = () => {
    if (scheduled === null) return;
    clearTimer(scheduled.handle);
    scheduled = null;
  };
  const begin = ({generation, demuxIdentity, kind, target = null}) => {
    cancelScheduled();
    current = Object.freeze({
      generation,
      serial: ++serial,
      demuxIdentity,
      kind,
      target,
    });
    return current;
  };
  const isCurrent = token => token !== null && token === current;
  const isCurrentDemux = demuxIdentity =>
    current !== null && current.demuxIdentity === demuxIdentity;
  const assertCurrent = token => {
    if (!isCurrent(token)) throw playbackIntentSupersededError();
  };
  const schedule = (token, delay, operation) => {
    assertCurrent(token);
    cancelScheduled();
    const entry = {handle: null, token};
    entry.handle = setTimer(() => {
      if (scheduled !== entry) return;
      scheduled = null;
      if (!isCurrent(token)) return;
      void operation(token);
    }, delay);
    scheduled = entry;
  };
  const runCommit = (token, operation) => {
    const pending = commitLane.then(async () => {
      assertCurrent(token);
      const result = await operation(() => assertCurrent(token));
      assertCurrent(token);
      return result;
    });
    commitLane = pending.catch(() => {});
    return pending;
  };
  const invalidate = () => {
    cancelScheduled();
    current = null;
  };
  const complete = token => {
    if (!isCurrent(token)) return false;
    cancelScheduled();
    current = null;
    return true;
  };

  return {
    begin,
    current: () => current,
    isCurrent,
    isCurrentDemux,
    assertCurrent,
    schedule,
    runCommit,
    cancelScheduled,
    complete,
    invalidate,
  };
}

export {createMseRecordedSeekSession} from './mse-recorded-seek.mjs';
