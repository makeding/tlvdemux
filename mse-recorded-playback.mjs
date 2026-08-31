import {commonBufferedAhead} from './mse-playback-buffer.mjs';
import {MseAppendQuotaError} from './mse-append-queue.mjs';

export const MSE_RECORDED_READ_BUDGET_BYTES = 16 * 1024 * 1024;
export const MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND = 'MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND';
export const MSE_RECORDED_VIDEO_NOT_FOUND = 'MSE_RECORDED_VIDEO_NOT_FOUND';
export const MSE_RECORDED_ATOMIC_COMMIT_FAILED = 'MSE_RECORDED_ATOMIC_COMMIT_FAILED';
export const MSE_RECORDED_SOURCE_FAILED = 'MSE_RECORDED_SOURCE_FAILED';

const STATES = new Set([
  'idle', 'locating-audio', 'resolving-video', 'committing',
  'running', 'ended', 'error',
]);
const VIDEO_MODES = new Set(['preferred', 'rainfall', 'frozen']);

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and non-negative.`);
  return value;
}

function covers(window, audio) {
  return window.closed !== false &&
    window.startTimeSeconds <= audio.startTimeSeconds + 0.000001 &&
    window.endTimeSeconds >= audio.endTimeSeconds - 0.000001;
}

export function resolveRecordedVideoWindow({audio, preferred = [], rainfall = [], frozen = []}) {
  if (!audio || !(audio.endTimeSeconds > audio.startTimeSeconds)) {
    throw new TypeError('A non-empty AAC window is required.');
  }
  const chooseCovering = candidates => candidates
    .filter(candidate => covers(candidate, audio))
    .sort((left, right) => right.startTimeSeconds - left.startTimeSeconds)[0] ?? null;
  const preferredVideo = chooseCovering(preferred);
  if (preferredVideo) return {mode: 'preferred', video: preferredVideo, audio};
  const rainfallVideo = chooseCovering(rainfall);
  if (rainfallVideo) return {mode: 'rainfall', video: rainfallVideo, audio};
  const previous = frozen
    .filter(candidate => candidate.closed !== false &&
      candidate.startTimeSeconds <= audio.startTimeSeconds + 0.000001)
    .sort((left, right) => right.startTimeSeconds - left.startTimeSeconds)[0] ?? null;
  return previous ? {mode: 'frozen', video: previous, audio} : null;
}

export class MseRecordedPlaybackError extends Error {
  constructor(code, message, diagnostics) {
    super(`${code}: ${message}`);
    this.name = 'MseRecordedPlaybackError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function unitTimeSeconds(unit) {
  if (unit?.ptsValue === undefined || !unit.ptsTimescale) return null;
  return Number(BigInt(unit.ptsValue) * 1000000n / BigInt(unit.ptsTimescale)) / 1000000;
}

export function createMseRecordedWindowLocator({
  source,
  demuxer,
  queues,
  presentationStartUs = 0n,
  selectedAudioTrack,
  preferredVideoTrack,
  rainfallVideoTrack = () => null,
  activateVideoTrack = async () => {},
  onProgress = () => {},
  chunkBytes = 1024 * 1024,
}) {
  const audioUnits = [];
  const videoRaps = [];
  let currentPushOffset = 0n;
  const trackId = value => value === null || value === undefined
    ? null : BigInt(typeof value === 'object' ? value.trackId : value);
  const insert = (items, item) => {
    if (!items.some(existing => existing.trackId === item.trackId &&
        existing.startTimeSeconds === item.startTimeSeconds &&
        existing.inputOffset === item.inputOffset)) {
      items.push(item);
      items.sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);
    }
  };
  const observeAccessUnit = unit => {
    const seconds = unitTimeSeconds(unit);
    if (seconds === null) return;
    const id = BigInt(unit.trackId);
    const inputOffset = BigInt(unit.inputOffset ?? currentPushOffset);
    const restartOffset = BigInt(unit.restartOffset ?? inputOffset);
    if (unit.codec === 'aac-latm' && id === trackId(selectedAudioTrack())) {
      insert(audioUnits, {trackId: id, startTimeSeconds: seconds, inputOffset, restartOffset});
    } else if (unit.codec === 'hevc' && unit.randomAccess) {
      const preferred = id === trackId(preferredVideoTrack());
      const rainfall = id === trackId(rainfallVideoTrack());
      if (!preferred && !rainfall) return;
      insert(videoRaps, {
        trackId: id, startTimeSeconds: seconds, endTimeSeconds: Infinity,
        inputOffset, restartOffset, closed: unit.closedRandomAccess === true,
        layer: preferred ? 'preferred' : 'rainfall',
      });
    }
  };
  const locate = async ({
    targetTimeSeconds, readBudgetBytes, signal, transition,
    waitForQueues = () => Promise.all([...queues.values()].map(queue =>
      queue.waitStable?.() ?? queue.waitIdle?.())),
  }) => {
    const sourceTargetSeconds = Number(presentationStartUs) / 1000000 + targetTimeSeconds;
    const budget = BigInt(readBudgetBytes);
    const chunk = BigInt(chunkBytes);
    let bytesRead = 0n;
    const read = async offset => {
      if (signal.aborted) throw abortError();
      const remaining = budget - bytesRead;
      if (remaining <= 0n) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
          'The AAC target window exceeded the 16 MiB transaction budget.', {});
      }
      const length = [chunk, remaining, source.size - offset].reduce(
        (minimum, value) => value < minimum ? value : minimum);
      if (length <= 0n) return null;
      const data = await source.read(offset, length);
      bytesRead += BigInt(data.byteLength);
      onProgress({bytesRead, budgetBytes: budget, offset});
      return data;
    };
    const push = async (data, offset) => {
      currentPushOffset = offset;
      if (!await demuxer.push(data)) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_SOURCE_FAILED, `The demuxer rejected input at ${offset}.`, {});
      }
    };
    const audioWindow = () => {
      const selected = audioUnits.filter(unit => unit.trackId === trackId(selectedAudioTrack()));
      const first = [...selected].reverse().find(unit =>
        unit.startTimeSeconds <= sourceTargetSeconds + 0.000001) ?? selected[0];
      if (!first) return null;
      const second = selected.find(unit => unit.startTimeSeconds >=
        Math.max(sourceTargetSeconds, first.startTimeSeconds) + 2);
      return second ? {
        startTimeSeconds: first.startTimeSeconds,
        endTimeSeconds: second.startTimeSeconds,
        inputOffset: first.inputOffset,
        restartOffset: first.restartOffset,
      } : null;
    };
    const resolve = audio => {
      const closeGops = layer => videoRaps.filter(rap => rap.layer === layer).map(rap => {
        const next = videoRaps.find(candidate => candidate.trackId === rap.trackId &&
          candidate.startTimeSeconds > rap.startTimeSeconds);
        return {...rap, endTimeSeconds: next?.startTimeSeconds ?? Infinity};
      });
      return resolveRecordedVideoWindow({
        audio,
        preferred: closeGops('preferred'),
        rainfall: closeGops('rainfall'),
        frozen: videoRaps.filter(rap => rap.closed),
      });
    };

    transition('locating-audio');
    await demuxer.setMseOutputEnabled(false);
    const targetUs = BigInt(Math.round(sourceTargetSeconds * 1000000));
    const estimate = await demuxer.estimateRecordedAudioOffset?.(targetUs, source.size) ??
      await demuxer.estimateOffset?.(targetUs, source.size) ?? 0n;
    let offset = BigInt(estimate) > chunk ? BigInt(estimate) - chunk : 0n;
    await demuxer.reposition(offset, true);
    let audio = null;
    let choice = null;
    while (offset < source.size && bytesRead < budget && !choice) {
      const data = await read(offset);
      if (!data?.byteLength) break;
      await push(data, offset);
      offset += BigInt(data.byteLength);
      audio = audioWindow();
      if (audio) {
        transition('resolving-video');
        choice = resolve(audio);
      }
    }
    if (!audio) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
        'No selected-AAC anchor window was found for the requested time.', {});
    }
    if (!choice) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_VIDEO_NOT_FOUND,
        'No preferred, rainfall, or prior closed video was found for the AAC window.', {});
    }

    await activateVideoTrack(choice.mode, choice.video);
    const landingOffset = choice.mode === 'frozen'
      ? audio.restartOffset : BigInt(choice.video.restartOffset);
    await demuxer.reposition(landingOffset, true);
    await demuxer.setMseOutputEnabled(true);
    if (choice.mode === 'frozen') {
      const repeated = await demuxer.repeatLastClosedVideoWindow(
        BigInt(Math.round(audio.startTimeSeconds * 1000000)),
        BigInt(Math.round(audio.endTimeSeconds * 1000000)));
      if (!repeated) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_VIDEO_NOT_FOUND,
          'The prior closed picture could not be repeated over the AAC window.', {});
      }
    }
    offset = landingOffset;
    const mediaTarget = targetTimeSeconds;
    const committed = () => {
      const ranges = [...queues.values()].map(queue => queue.committedRanges?.() ?? []);
      return ranges.length >= 2 && ranges.every(trackRanges => trackRanges.some(range =>
        range.start <= mediaTarget + 0.05 && range.end >= mediaTarget + 0.001));
    };
    while (!committed() && offset < source.size && bytesRead < budget) {
      const data = await read(offset);
      if (!data?.byteLength) break;
      await push(data, offset);
      offset += BigInt(data.byteLength);
      await waitForQueues();
    }
    if (!committed()) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_ATOMIC_COMMIT_FAILED,
        'The selected AAC window and resolved video did not commit atomically.', {});
    }
    return {nextOffset: offset, bytesRead, videoMode: choice.mode, audio, video: choice.video};
  };
  return {locate, observeAccessUnit};
}

export function createMseRecordedPlaybackController({
  source,
  demuxer,
  media,
  queues,
  initialOffset = 0n,
  highWallSeconds = 2,
  lowWallSeconds = 1,
  quotaStartWallSeconds = 0.5,
  readBudgetBytes = MSE_RECORDED_READ_BUDGET_BYTES,
  commonAhead = () => commonBufferedAhead(media, queues),
  locateSeekWindow,
  switchVideoMode = () => {},
  play = () => media.play?.(),
  onPlaybackStart = () => {},
  onStateChange = () => {},
  onProgress = () => {},
}) {
  if (!source?.stream || typeof source.read !== 'function') {
    throw new TypeError('Recorded playback requires source.stream() and source.read().');
  }
  if (!demuxer || typeof demuxer.push !== 'function') throw new TypeError('A demuxer is required.');
  if (!media || !queues || typeof queues.values !== 'function') {
    throw new TypeError('A MediaElement clock and A/V queues are required.');
  }
  if (typeof locateSeekWindow !== 'function') {
    throw new TypeError('Recorded playback requires an AAC-window locator.');
  }
  finiteNonNegative(highWallSeconds, 'highWallSeconds');
  finiteNonNegative(lowWallSeconds, 'lowWallSeconds');
  finiteNonNegative(quotaStartWallSeconds, 'quotaStartWallSeconds');
  if (!(highWallSeconds > lowWallSeconds)) throw new TypeError('highWallSeconds must exceed lowWallSeconds.');

  let state = 'idle';
  let videoMode = 'preferred';
  let fallbackReason = null;
  let nextOffset = BigInt(initialOffset);
  let bytesRead = 0n;
  let intent = 0;
  let streamController = null;
  let feedPromise = null;
  let playbackRate = media.playbackRate > 0 ? media.playbackRate : 1;
  let presentedTime = null;
  let qualityFailures = 0;
  let playbackStarted = false;
  let quotaLimitedStartup = false;
  let progressWaiter = null;
  let lastProgress = null;
  let completion = null;
  const ensureCompletion = () => {
    if (!completion) {
      let resolve;
      let reject;
      const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      completion = {promise, resolve, reject};
    }
    return completion;
  };

  const snapshot = () => ({
    state, videoMode, fallbackReason, intent, nextOffset: nextOffset.toString(),
    bytesRead: bytesRead.toString(), playbackRate, presentedTime,
    playbackStarted, quotaLimitedStartup,
    commonAhead: commonAhead(), queueStates: Object.fromEntries([...queues].map(([type, queue]) => [type, {
      queuedBytes: queue.queuedBytes ?? null,
      currentBytes: queue.currentBytes ?? null,
      state: queue.state ?? null,
      quotaBlocked: queue.quotaBlocked ?? false,
      buffered: queue.bufferedRanges?.() ?? [],
      committed: queue.committedRanges?.() ?? [],
    }])),
    lastProgress,
  });
  const transition = next => {
    if (!STATES.has(next)) throw new TypeError(`Unknown Recorded state ${next}.`);
    if (state === next) return;
    state = next;
    onStateChange(snapshot());
  };
  const setMode = (mode, reason) => {
    if (!VIDEO_MODES.has(mode)) throw new TypeError(`Unknown Recorded video mode ${mode}.`);
    if (videoMode === mode && fallbackReason === reason) return;
    videoMode = mode;
    fallbackReason = reason;
    switchVideoMode(mode, reason);
    onStateChange(snapshot());
  };
  const wakeProgress = () => {
    const wake = progressWaiter;
    progressWaiter = null;
    wake?.();
  };
  const active = generation => generation === intent && !streamController?.signal.aborted;
  const waitForProgress = generation => new Promise((resolve, reject) => {
    if (!active(generation)) {
      reject(abortError());
      return;
    }
    progressWaiter = resolve;
  });
  const waitForLowWater = async generation => {
    while (active(generation) && commonAhead() > lowWallSeconds * playbackRate) {
      await waitForProgress(generation);
    }
    if (!active(generation)) throw abortError();
  };
  const startPlayback = quotaLimited => {
    if (playbackStarted) return true;
    const required = (quotaLimited ? quotaStartWallSeconds : highWallSeconds) * playbackRate;
    if (commonAhead() + 0.001 < required) return false;
    playbackStarted = true;
    quotaLimitedStartup = quotaLimited;
    let playResult;
    try {
      playResult = play();
    } catch (error) {
      playResult = Promise.reject(error);
    }
    onPlaybackStart({quotaLimited, playResult, diagnostics: snapshot()});
    return true;
  };
  const retryQuotaWhenSafe = async generation => {
    startPlayback(true);
    while (active(generation)) {
      const blocked = [...queues.values()].filter(queue => queue.quotaBlocked);
      if (!blocked.length) return;
      const removeEnd = presentedTime === null ? null : presentedTime - 3;
      const safe = removeEnd !== null && blocked.every(queue =>
        queue.canRetryQuotaAfterRemove?.(removeEnd) ?? false);
      if (safe) {
        for (const queue of blocked) {
          if (!queue.retryQuotaAfterRemove(removeEnd)) {
            throw new MseRecordedPlaybackError(
              MSE_RECORDED_ATOMIC_COMMIT_FAILED,
              'The safe presented-history removal changed before quota retry.', snapshot());
          }
        }
        await Promise.all([...queues.values()].map(queue =>
          queue.waitStable?.() ?? queue.waitIdle?.()));
        return;
      }
      await waitForProgress(generation);
      startPlayback(true);
    }
    throw abortError();
  };
  const waitForQueues = async generation => {
    try {
      await Promise.all([...queues.values()].map(queue =>
        queue.waitStable?.() ?? queue.waitIdle?.()));
    } catch (error) {
      const quotaError = error instanceof MseAppendQuotaError ||
        error?.name === 'MseAppendQuotaError' || error?.code === 'MSE_APPEND_QUOTA';
      if (!quotaError) throw error;
      await retryQuotaWhenSafe(generation);
    }
  };
  const commitFragment = async (generation, data, offset) => {
    transition('committing');
    const accepted = await demuxer.push(data);
    if (accepted === false) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_ATOMIC_COMMIT_FAILED, `The demuxer rejected input at ${offset}.`, snapshot());
    }
    await waitForQueues(generation);
    if (!active(generation)) throw abortError();
    transition('running');
    startPlayback(false);
  };
  const feed = async generation => {
    streamController = new AbortController();
    try {
      transition(nextOffset === 0n ? 'locating-audio' : 'running');
      for await (const data of source.stream(nextOffset, {signal: streamController.signal})) {
        if (!active(generation)) throw abortError();
        if (!(data instanceof Uint8Array) || data.byteLength === 0) {
          throw new MseRecordedPlaybackError(
            MSE_RECORDED_SOURCE_FAILED, `The source returned an empty fragment at ${nextOffset}.`, snapshot());
        }
        const offset = nextOffset;
        if (commonAhead() >= highWallSeconds * playbackRate) await waitForLowWater(generation);
        await commitFragment(generation, data, offset);
        const length = BigInt(data.byteLength);
        nextOffset += length;
        bytesRead += length;
        lastProgress = {offset: offset.toString(), bytes: data.byteLength};
        onProgress(snapshot());
      }
      if (generation === intent) {
        transition('ended');
        completion?.resolve();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== intent) return;
      transition('error');
      const failure = error instanceof MseRecordedPlaybackError ? error : new MseRecordedPlaybackError(
        MSE_RECORDED_SOURCE_FAILED, error?.message ?? String(error), snapshot());
      completion?.reject(failure);
      throw failure;
    }
  };
  const beginFeed = () => {
    const generation = intent;
    feedPromise = feed(generation);
    return feedPromise;
  };
  const cancelFeed = async () => {
    streamController?.abort();
    wakeProgress();
    try { await feedPromise; } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    }
    feedPromise = null;
    streamController = null;
  };
  const locateTransaction = async (target, generation, installClock) => {
    transition('locating-audio');
    const transactionController = new AbortController();
    streamController = transactionController;
    const result = await locateSeekWindow({
      targetTimeSeconds: target,
      readBudgetBytes: BigInt(readBudgetBytes),
      signal: transactionController.signal,
      transition: next => transition(next),
      waitForQueues: () => waitForQueues(generation),
    });
    if (!result || result.nextOffset === undefined || !VIDEO_MODES.has(result.videoMode)) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_VIDEO_NOT_FOUND,
        'No preferred, rainfall, or prior closed video covers the AAC target window.', snapshot());
    }
    if (BigInt(result.bytesRead ?? 0n) > BigInt(readBudgetBytes)) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
        'The AAC target window exceeded the 16 MiB transaction budget.', snapshot());
    }
    transition('committing');
    await waitForQueues(generation);
    if (!active(generation)) throw abortError();
    nextOffset = BigInt(result.nextOffset);
    bytesRead += BigInt(result.bytesRead ?? 0n);
    setMode(result.videoMode, result.videoMode === 'preferred' ? null : 'source-damage');
    if (installClock) media.currentTime = target;
    transition('running');
    startPlayback(false);
    if (streamController === transactionController) streamController = null;
    return result;
  };
  const fail = error => {
    transition('error');
    const failure = error instanceof MseRecordedPlaybackError ? error : new MseRecordedPlaybackError(
      MSE_RECORDED_SOURCE_FAILED, error?.message ?? String(error), snapshot());
    completion?.reject(failure);
    return failure;
  };

  return {
    get state() { return state; },
    get videoMode() { return videoMode; },
    get nextOffset() { return nextOffset; },
    get bytesRead() { return bytesRead; },
    watermarks() {
      return {
        highMediaSeconds: highWallSeconds * playbackRate,
        lowMediaSeconds: lowWallSeconds * playbackRate,
      };
    },
    diagnostics: snapshot,
    setPlaybackRate(rate) {
      playbackRate = finiteNonNegative(rate, 'playbackRate');
      if (!(playbackRate > 0)) throw new TypeError('playbackRate must be positive.');
      wakeProgress();
      return this.watermarks();
    },
    notifyPresentedFrame(mediaTimeSeconds) {
      presentedTime = finiteNonNegative(mediaTimeSeconds, 'mediaTimeSeconds');
      wakeProgress();
    },
    notifyConsumption() { wakeProgress(); },
    reportSourceDamage() { setMode('rainfall', 'source-damage'); },
    notifyPreferredStableRap() {
      if (fallbackReason === 'source-damage') setMode('preferred', null);
    },
    reportPlaybackQuality({totalFrames, droppedFrames, durationSeconds = 5, mediaError = null}) {
      if (mediaError) {
        qualityFailures = 2;
        setMode('rainfall', 'decoder-performance');
        return videoMode;
      }
      const total = finiteNonNegative(totalFrames, 'totalFrames');
      const dropped = finiteNonNegative(droppedFrames, 'droppedFrames');
      const duration = finiteNonNegative(durationSeconds, 'durationSeconds');
      const healthyBuffer = commonAhead() >= playbackRate;
      const failed = duration >= 5 && total > 0 && dropped / total > 0.2 && healthyBuffer;
      qualityFailures = failed ? qualityFailures + 1 : 0;
      if (qualityFailures >= 2) setMode('rainfall', 'decoder-performance');
      return videoMode;
    },
    async start(targetTimeSeconds = media.currentTime) {
      const target = finiteNonNegative(targetTimeSeconds, 'targetTimeSeconds');
      const result = ensureCompletion();
      if (feedPromise) return result.promise;
      intent += 1;
      const generation = intent;
      feedPromise = (async () => {
        await locateTransaction(target, generation, false).catch(error => {
          if (error?.name === 'AbortError' || generation !== intent) return;
          throw fail(error);
        });
        if (generation !== intent) return;
        return feed(generation);
      })();
      void feedPromise.catch(() => {});
      return result.promise;
    },
    async seek(targetTimeSeconds) {
      const target = finiteNonNegative(targetTimeSeconds, 'targetTimeSeconds');
      intent += 1;
      await cancelFeed();
      qualityFailures = 0;
      fallbackReason = null;
      const generation = intent;
      try {
        const result = await locateTransaction(target, generation, true);
        intent += 1;
        ensureCompletion();
        void beginFeed().catch(() => {});
        return result;
      } catch (error) {
        if (error instanceof MseRecordedPlaybackError) throw error;
        transition('error');
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_ATOMIC_COMMIT_FAILED, error?.message ?? String(error), snapshot());
      }
    },
    async stop() {
      intent += 1;
      await cancelFeed();
      transition('idle');
      completion?.resolve();
      completion = null;
    },
  };
}
