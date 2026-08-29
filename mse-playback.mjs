import {
  ENTRY_TOLERANCE_SECONDS,
} from './mse-playback-buffer.mjs';
export {
  commonBufferedAhead,
  commonBufferedRanges,
  startMsePlayback,
} from './mse-playback-buffer.mjs';
import {
  MSE_SEEK_READ_BUDGET_BYTES,
  MsePlaybackMode,
  MseRecordedSeekError,
  MseStartupBufferError,
  TLV_VIDEO_UNAVAILABLE,
} from './mse-playback-contract.mjs';
import {createMsePlaybackFlowControl} from './mse-playback-flow-control.mjs';
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

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
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

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The seek was superseded.', 'AbortError');
  const error = new Error('The seek was superseded.');
  error.name = 'AbortError';
  return error;
}

function timestampUs(unit) {
  if (unit.ptsValue === undefined || !unit.ptsTimescale) return null;
  return BigInt(unit.ptsValue) * 1000000n / BigInt(unit.ptsTimescale);
}

function clampBigInt(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function createMseRecordedSeekSession({
  targetTimeSeconds,
  targetUs = BigInt(Math.round(targetTimeSeconds * 1000000)),
  durationUs,
  presentationStartUs = 0n,
  presentationEndUs = BigInt(presentationStartUs) + BigInt(durationUs),
  source,
  demuxer,
  media,
  queues,
  requiredTracks = ['video', 'audio'],
  flowControl = createMsePlaybackFlowControl({
    media, queues, requiredTracks, entryKind: 'seek',
    entryTimeSeconds: Number(targetUs) / 1000000,
  }),
  signal = null,
  isActive = () => true,
  headReady,
  candidateTrack = null,
  candidateVideoTrack = candidateTrack ?? (requiredTracks.length === 1 && requiredTracks[0] === 'audio'
    ? track => track.kind === 'audio'
    : track => track.kind === 'video'),
  trackPriority = null,
  videoTrackPriority = trackPriority ?? (() => 0),
  activateTrack = null,
  activateVideoTrack = activateTrack ?? (async () => {}),
  beforeLanding = async () => {},
  estimateOffset = null,
  waitForAppends = async () => {
    await Promise.all([...queues.values()].map(queue => queue.waitStable?.() ?? Promise.resolve()));
  },
  checkError = () => {},
  chunkBytes = DEFAULT_CHUNK_BYTES,
  readBudgetBytes = MSE_SEEK_READ_BUDGET_BYTES,
  probePrerollSeconds = 2,
  onProgress = () => {},
}) {
  if (!source || typeof source.read !== 'function' || typeof source.size !== 'bigint') {
    throw new TypeError('A recorded source with bigint size and read(offset, length) is required.');
  }
  if (!durationUs || durationUs <= 0n) throw new TypeError('durationUs must be positive.');
  if (!demuxer || typeof demuxer.push !== 'function') throw new TypeError('A demuxer is required.');
  if (typeof demuxer.setMseRecordedSeekConcealmentTarget !== 'function') {
    throw new TypeError('The demuxer must support recorded-seek concealment targets.');
  }
  if (typeof headReady !== 'function') throw new TypeError('headReady must be a function.');

  const chunkSize = BigInt(chunkBytes);
  const budget = BigInt(readBudgetBytes);
  const sourceTargetUs = BigInt(presentationStartUs) + BigInt(targetUs);
  const sourceEndUs = BigInt(presentationEndUs);
  const toleranceUs = BigInt(Math.round(ENTRY_TOLERANCE_SECONDS * 1000000));
  const probePrerollUs = BigInt(Math.round(probePrerollSeconds * 1000000));
  const minimumLandingPrerollUs = requiredTracks.includes('video') &&
    requiredTracks.includes('audio') ? 1000000n : 0n;
  const tracks = new Map();
  const cachedRanges = [];
  const probeFrontiers = new Map();
  const probeRaps = new Map();
  let timelineBeforeTarget = {
    ptsUs: BigInt(presentationStartUs),
    offset: 0n,
  };
  let timelineAfterTarget = null;
  let phase = 'idle';
  let bytesRead = 0n;
  let currentPushOffset = 0n;

  const active = () => !signal?.aborted && isActive();
  const ensureActive = () => { if (!active()) throw abortError(); };
  const candidates = () => [...tracks.values()].filter(candidateVideoTrack);

  const observeTrack = track => tracks.set(track.trackId, track);
  const observeTrackRemoved = track => tracks.delete(track.trackId);
  const observeAccessUnit = unit => {
    if (phase !== 'head' && phase !== 'probe') return;
    const track = tracks.get(unit.trackId);
    if (!track || !candidateVideoTrack(track)) return;
    if (track.kind === 'video' && unit.codec !== 'hevc') return;
    if (track.kind === 'audio' && unit.codec !== 'aac-latm') return;
    const pts = timestampUs(unit);
    if (pts === null) return;
    const sample = {
      ptsUs: pts,
      offset: unit.inputOffset === undefined ? currentPushOffset : BigInt(unit.inputOffset),
    };
    if (pts <= sourceTargetUs) {
      if (!timelineBeforeTarget || pts > timelineBeforeTarget.ptsUs) {
        timelineBeforeTarget = sample;
      }
    } else if (!timelineAfterTarget || pts < timelineAfterTarget.ptsUs) {
      timelineAfterTarget = sample;
    }
    if (phase !== 'probe') return;
    const previousFrontier = probeFrontiers.get(unit.trackId);
    if (previousFrontier === undefined || pts > previousFrontier) probeFrontiers.set(unit.trackId, pts);
    if ((track.kind === 'video' && !unit.randomAccess) || pts > sourceTargetUs + toleranceUs) return;
    const previous = probeRaps.get(unit.trackId);
    if (!previous || pts > previous.ptsUs) {
      probeRaps.set(unit.trackId, {
        trackId: unit.trackId,
        ptsUs: pts,
        seconds: Number(unit.ptsValue) / unit.ptsTimescale,
        restartOffset: BigInt(unit.restartOffset),
      });
    }
  };

  const cachedAt = offset => cachedRanges.find(item => item.start <= offset && item.end > offset);
  const nextCachedStart = offset => cachedRanges.reduce(
    (next, item) => item.start > offset && (next === null || item.start < next) ? item.start : next,
    null,
  );
  const read = async (offset, wanted) => {
    ensureActive();
    const cached = cachedAt(offset);
    if (cached) {
      const available = cached.end - offset < wanted ? cached.end - offset : wanted;
      const start = Number(offset - cached.start);
      return cached.data.subarray(start, start + Number(available));
    }
    if (bytesRead >= budget) throw new MseRecordedSeekError('budget-exhausted');
    const remainingSource = source.size - offset;
    const remainingBudget = budget - bytesRead;
    let length = wanted < remainingSource ? wanted : remainingSource;
    if (length > remainingBudget) length = remainingBudget;
    const next = nextCachedStart(offset);
    if (next !== null && offset + length > next) length = next - offset;
    if (length <= 0n) throw new MseRecordedSeekError('budget-exhausted');
    const data = await source.read(offset, length);
    ensureActive();
    if (!(data instanceof Uint8Array)) throw new TypeError('source.read() must return Uint8Array.');
    if (!data.byteLength) throw new MseRecordedSeekError('source-ended');
    bytesRead += BigInt(data.byteLength);
    cachedRanges.push({start: offset, end: offset + BigInt(data.byteLength), data});
    cachedRanges.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
    onProgress({phase, bytesRead, budgetBytes: budget, offset});
    return data;
  };

  const push = async (data, offset) => {
    ensureActive();
    currentPushOffset = offset;
    const accepted = await demuxer.push(data);
    checkError();
    if (!accepted) {
      throw new MseRecordedSeekError('demux-failed', `The demuxer rejected input at byte ${offset}.`);
    }
  };

  const frontiersPastTarget = () => {
    const eligible = new Set(candidates().map(track => track.trackId));
    const observed = [...probeFrontiers].filter(([trackId]) => eligible.has(trackId));
    return observed.length > 0 && observed.every(([, frontier]) =>
      frontier > sourceTargetUs + toleranceUs);
  };

  const bestRap = () => [...probeRaps.values()]
    .filter(rap => rap.ptsUs <= sourceTargetUs && tracks.has(rap.trackId))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;

  const hasUsablePrerollRap = () => {
    const rap = bestRap();
    return rap !== null && rap.ptsUs + probePrerollUs >= sourceTargetUs;
  };

  const interpolatedTargetOffset = () => {
    const before = timelineBeforeTarget;
    const after = timelineAfterTarget;
    if (!before || !after || after.ptsUs === before.ptsUs || after.offset <= before.offset) return null;
    return before.offset + (after.offset - before.offset) * (sourceTargetUs - before.ptsUs) /
      (after.ptsUs - before.ptsUs);
  };

  const run = async () => {
    ensureActive();
    phase = 'head';
    await demuxer.setMseOutputEnabled(false);
    await demuxer.setMseTimestampOffset?.(-BigInt(presentationStartUs));
    let headOffset = 0n;
    while (!headReady()) {
      if (headOffset >= source.size) throw new MseRecordedSeekError('source-ended');
      const data = await read(headOffset, chunkSize);
      await push(data, headOffset);
      headOffset += BigInt(data.byteLength);
    }

    ensureActive();
    if (!await demuxer.setIndexDuration(sourceEndUs)) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer rejected the recording duration.');
    }
    let estimateValue = estimateOffset === null
      ? null : await estimateOffset(sourceTargetUs, source.size);
    if (estimateValue === null || estimateValue === undefined) {
      estimateValue = await demuxer.estimateOffset(sourceTargetUs, source.size);
    }
    if (estimateValue === null || estimateValue === undefined) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer could not estimate the target byte position.');
    }
    const estimate = BigInt(estimateValue);
    const estimatedWindow = source.size * BigInt(Math.round(probePrerollSeconds * 1000000)) / durationUs;
    const window = clampBigInt(estimatedWindow, chunkSize, 2n * 1024n * 1024n);
    const estimateForwardBias = 10n * 1024n * 1024n * BigInt(targetUs) / durationUs;
    let candidate = clampBigInt(estimate + estimateForwardBias, 0n,
      source.size > chunkSize ? source.size - chunkSize : 0n);
    let chosen = null;

    for (;;) {
      ensureActive();
      phase = 'probe';
      probeFrontiers.clear();
      probeRaps.clear();
      await demuxer.reposition(candidate, true);
      let offset = candidate;
      while (offset < source.size && !frontiersPastTarget() && !hasUsablePrerollRap()) {
        const data = await read(offset, chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
      }
      chosen = bestRap();
      if (chosen && (sourceTargetUs - chosen.ptsUs >= minimumLandingPrerollUs ||
          candidate === 0n)) break;
      if (chosen) {
        const earlierCandidate = chosen.restartOffset > window
          ? chosen.restartOffset - window : 0n;
        candidate = earlierCandidate < candidate
          ? earlierCandidate : candidate > window ? candidate - window : 0n;
        continue;
      }
      if (candidate === 0n) throw new MseRecordedSeekError('no-rap');
      const interpolated = interpolatedTargetOffset();
      const interpolatedCandidate = interpolated === null ? null
        : interpolated > window ? interpolated - window : 0n;
      const nextCandidate = interpolatedCandidate !== null && interpolatedCandidate < candidate
        ? interpolatedCandidate : candidate > window ? candidate - window : 0n;
      candidate = nextCandidate < candidate ? nextCandidate : 0n;
    }

    const chosenTrack = tracks.get(chosen.trackId);
    await activateVideoTrack(chosenTrack, chosen);
    ensureActive();
    phase = 'landing';
    let offset = chosen.restartOffset;
    await demuxer.reposition(offset, true);
    await beforeLanding(chosenTrack, chosen);
    await demuxer.setMseOutputEnabled(true);
    const videoConcealment = requiredTracks.includes('video');
    await demuxer.setMseRecordedSeekConcealmentTarget(
      videoConcealment ? sourceTargetUs : null);
    try {
      let pushedLandingInput = false;
      while (!pushedLandingInput || !flowControl.entryCovered()) {
        ensureActive();
        if (offset >= source.size) throw new MseRecordedSeekError('source-ended');
        const data = await read(offset, chunkSize);
        await push(data, offset);
        pushedLandingInput = true;
        offset += BigInt(data.byteLength);
        await waitForAppends();
        await flowControl.afterPush(data.byteLength, active);
      }
    } finally {
      if (videoConcealment) await demuxer.setMseRecordedSeekConcealmentTarget(null);
    }
    phase = 'complete';
    return {
      targetUs,
      sourceTargetUs,
      estimateOffset: estimate,
      restartOffset: chosen.restartOffset,
      rapPresentationTimeUs: chosen.ptsUs,
      nextOffset: offset,
      bytesRead,
      budgetBytes: budget,
    };
  };

  return {
    run,
    observeTrack,
    observeTrackRemoved,
    observeAccessUnit,
    get phase() { return phase; },
    get bytesRead() { return bytesRead; },
    get budgetBytes() { return budget; },
  };
}
