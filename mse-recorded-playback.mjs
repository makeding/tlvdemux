import {
  commonBufferedRanges,
  commonBufferedAhead,
  commonCommittedRanges,
  coveringBufferedRange,
  coveringRange,
  normalizeRequiredTracks,
} from './mse-playback-buffer.mjs';

export const MSE_RECORDED_SUPPLY_FAILED = 'MSE_RECORDED_SUPPLY_FAILED';
export const MSE_RECORDED_RECOVERY_FAILED = 'MSE_RECORDED_RECOVERY_FAILED';
export const MSE_RECORDED_STATES = Object.freeze([
  'idle', 'preparing', 'locating-entry', 'supplying', 'draining',
  'finalizing', 'ended', 'seeking', 'recovering', 'cancelled', 'failed',
]);

const STATE_SET = new Set(MSE_RECORDED_STATES);
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_HIGH_SECONDS = 15;
const DEFAULT_LOW_SECONDS = 8;
const DEFAULT_DIAGNOSTIC_LIMIT = 64;
const DEFAULT_PROGRESS_POLL_MILLISECONDS = 250;
const RECOVERY_MAX_READ_BYTES = 64n * 1024n * 1024n;
const RECOVERY_TOLERANCE_SECONDS = 0.000002;
const RECOVERY_CANCELLATION_EVENTS = new Set([
  'pause', 'paused', 'media-paused', 'track-selection', 'track-changed',
  'layer-selection', 'source-eof', 'eof', 'cancel-recovery',
]);

function abortError(message = 'The Recorded operation was superseded.') {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be finite and non-negative.`);
  }
  return value;
}

function bigintNonNegative(value, name) {
  const result = BigInt(value);
  if (result < 0n) throw new TypeError(`${name} must be non-negative.`);
  return result;
}

function queueSnapshot(queue) {
  if (typeof queue?.snapshot === 'function') return queue.snapshot();
  const pending = Array.isArray(queue?.queue) ? queue.queue : [];
  return {
    state: queue?.state ?? null,
    updating: Boolean(queue?.sourceBuffer?.updating),
    mutationInProgress: Boolean(queue?.sourceBuffer?.updating),
    pendingMutations: pending.length,
    pendingAppends: pending.filter(item => item?.kind === 'append').length,
    pendingReconfigurations: pending.filter(item =>
      item?.kind === 'timestamp-offset' || item?.kind === 'remove' || item?.mime !== null,
    ).length,
    queuedBytes: Number(queue?.queuedBytes ?? 0),
    currentBytes: Number(queue?.currentBytes ?? 0),
    buffered: queue?.bufferedRanges?.() ?? [],
  };
}

export class MseRecordedPlaybackError extends Error {
  constructor(message, diagnostics, cause = null) {
    super(`${MSE_RECORDED_SUPPLY_FAILED}: ${message}`, cause ? {cause} : undefined);
    this.name = 'MseRecordedPlaybackError';
    this.code = MSE_RECORDED_SUPPLY_FAILED;
    this.diagnostics = diagnostics;
  }
}

export class MseRecordedRecoveryError extends Error {
  constructor(reason, diagnostics, cause = null) {
    super(`${MSE_RECORDED_RECOVERY_FAILED}: ${reason}`, cause ? {cause} : undefined);
    this.name = 'MseRecordedRecoveryError';
    this.code = MSE_RECORDED_RECOVERY_FAILED;
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

function recoveryCandidate(event) {
  const candidate = event?.type === 'recovery-candidate' || event?.type === 'recovery-state'
    ? event : null;
  if (!candidate) return null;
  const required = [
    'episodeId', 'videoTrackId', 'audioTrackId', 'sourceRapTimeUs',
    'commonAvBoundaryUs', 'restartOffset', 'timestampAnchorUs',
    'generation', 'exact', 'state', 'avState',
  ];
  if (required.some(name => candidate[name] === undefined || candidate[name] === null)) {
    return null;
  }
  try {
    const sourceRapTimeUs = bigintNonNegative(candidate.sourceRapTimeUs, 'sourceRapTimeUs');
    const commonAvBoundaryUs = bigintNonNegative(
      candidate.commonAvBoundaryUs, 'commonAvBoundaryUs',
    );
    const restartOffset = bigintNonNegative(candidate.restartOffset, 'restartOffset');
    const timestampAnchorUs = bigintNonNegative(
      candidate.timestampAnchorUs, 'timestampAnchorUs',
    );
    const generation = bigintNonNegative(candidate.generation, 'generation');
    return {
      ...candidate,
      sourceRapTimeUs,
      commonAvBoundaryUs,
      restartOffset,
      timestampAnchorUs,
      generation,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Owns the complete Recorded/File read lifecycle.  Live flow control and Live
 * transition state are deliberately not imported by this module.
 */
export function createMseRecordedPlaybackController({
  source,
  demuxer,
  media,
  queues,
  requiredTracks = ['video', 'audio'],
  initialOffset = 0n,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  highSeconds = DEFAULT_HIGH_SECONDS,
  lowSeconds = DEFAULT_LOW_SECONDS,
  diagnosticLimit = DEFAULT_DIAGNOSTIC_LIMIT,
  progressPollMilliseconds = DEFAULT_PROGRESS_POLL_MILLISECONDS,
  locateEntry = null,
  landRecovery = null,
  recoveryPositionSeconds = candidate => Number(candidate.commonAvBoundaryUs) / 1000000,
  checkError = () => {},
  finalize = async () => {},
  onStateChange = () => {},
  onProgress = () => {},
  onDiagnostic = () => {},
}) {
  if (!source || typeof source.read !== 'function' || typeof source.size !== 'bigint') {
    throw new TypeError('Recorded playback requires a bigint-sized source with read(offset, length).');
  }
  if (!demuxer || typeof demuxer.push !== 'function') {
    throw new TypeError('Recorded playback requires a demuxer with push(data).');
  }
  if (!media || !queues || typeof queues.get !== 'function') {
    throw new TypeError('Recorded playback requires a media clock and queue map.');
  }
  let tracks = normalizeRequiredTracks(requiredTracks);
  const readSize = BigInt(Math.trunc(finiteNonNegative(chunkBytes, 'chunkBytes')));
  const high = finiteNonNegative(highSeconds, 'highSeconds');
  const low = finiteNonNegative(lowSeconds, 'lowSeconds');
  const historyLimit = Math.max(1, Math.trunc(
    finiteNonNegative(diagnosticLimit, 'diagnosticLimit'),
  ));
  const pollMilliseconds = finiteNonNegative(
    progressPollMilliseconds, 'progressPollMilliseconds',
  );
  if (readSize <= 0n) throw new TypeError('chunkBytes must be positive.');
  if (!(high > low)) throw new TypeError('highSeconds must exceed lowSeconds.');

  let state = 'idle';
  let generation = 0;
  let offset = bigintNonNegative(initialOffset, 'initialOffset');
  let bytesRead = 0n;
  let feedPromise = null;
  let operation = Promise.resolve();
  let lastRecoveryPromise = Promise.resolve(null);
  let completion = null;
  let progressWaiter = null;
  let progressReason = null;
  let activeEntry = null;
  let entryTimeSeconds = 0;
  let entryToleranceSeconds = 0.05;
  let activeRecovery = null;
  let heldAudioTracks = null;
  const claimedRecoveryEpisodes = new Set();
  const history = [];
  const createCompletion = () => {
    if (completion) return completion;
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    completion = {promise, resolve, reject};
    return completion;
  };

  const queueStates = () => Object.fromEntries(tracks.map(type => [
    type, queueSnapshot(queues.get(type)),
  ]));
  const snapshot = (reason = null) => ({
    state,
    reason,
    generation,
    offset: offset.toString(),
    sourceSize: source.size.toString(),
    bytesRead: bytesRead.toString(),
    currentTime: Number(media.currentTime),
    commonAhead: commonBufferedAhead(media, queues, 0.05, tracks),
    requiredTracks: [...tracks],
    queues: queueStates(),
  });
  const record = (kind, reason = null) => {
    const item = {kind, ...snapshot(reason)};
    history.push(item);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    onDiagnostic(item);
    return item;
  };
  const transition = (next, reason = null) => {
    if (!STATE_SET.has(next)) throw new TypeError(`Unknown Recorded state: ${next}`);
    if (state === next) return snapshot(reason);
    const previous = state;
    state = next;
    const item = record('state-change', reason);
    onStateChange({...item, previous});
    return item;
  };
  const isCurrent = selectedGeneration => selectedGeneration === generation;
  const ensureCurrent = selectedGeneration => {
    if (!isCurrent(selectedGeneration)) throw abortError();
  };
  const syncRecoveryGeneration = async selectedGeneration => {
    await demuxer.setMseRecoveryGeneration?.(BigInt(selectedGeneration));
    ensureCurrent(selectedGeneration);
  };
  const serialize = task => {
    const run = operation.catch(() => {}).then(task);
    operation = run.catch(() => {});
    return run;
  };
  const wake = reason => {
    progressReason = reason;
    const waiter = progressWaiter;
    progressWaiter = null;
    waiter?.();
  };
  const waitForProgress = selectedGeneration => new Promise((resolve, reject) => {
    if (!isCurrent(selectedGeneration)) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (progressWaiter === finish) progressWaiter = null;
      resolve();
    };
    const timer = setTimeout(() => {
      record('no-progress', progressReason ?? 'drain-poll');
      finish();
    }, pollMilliseconds);
    progressWaiter = finish;
  });

  const drainReason = () => {
    const commonAhead = commonBufferedAhead(media, queues, 0.05, tracks);
    const states = tracks.map(type => queueSnapshot(queues.get(type)));
    if (commonAhead + 0.001 < low) return null;
    if (states.some(item => item.mutationInProgress || item.updating)) {
      return 'source-buffer-mutation';
    }
    if (states.some(item => item.pendingAppends > 0 || item.pendingReconfigurations > 0)) {
      return 'recorded-queue-drain';
    }
    if (commonAhead + 0.001 >= high) return 'recorded-high-water';
    return null;
  };

  const gatedSource = selectedGeneration => ({
    get size() { return source.size; },
    async read(readOffset, length) {
      ensureCurrent(selectedGeneration);
      if (state !== 'supplying') {
        throw new MseRecordedPlaybackError(
          `source.read() is forbidden while Recorded state is ${state}.`, snapshot(),
        );
      }
      const data = await source.read(BigInt(readOffset), BigInt(length));
      ensureCurrent(selectedGeneration);
      if (!(data instanceof Uint8Array)) {
        throw new TypeError('Recorded source.read() must return Uint8Array.');
      }
      return data;
    },
  });
  const gatedDemuxer = selectedGeneration => new Proxy(demuxer, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'push') {
        return async data => {
          ensureCurrent(selectedGeneration);
          if (state !== 'supplying') {
            throw new MseRecordedPlaybackError(
              `demuxer.push() is forbidden while Recorded state is ${state}.`, snapshot(),
            );
          }
          const result = await value.call(target, data);
          ensureCurrent(selectedGeneration);
          return result;
        };
      }
      if (property === 'reposition') {
        return async (...args) => {
          ensureCurrent(selectedGeneration);
          const result = await value.apply(target, args);
          ensureCurrent(selectedGeneration);
          return result;
        };
      }
      return value.bind(target);
    },
  });

  const recoveryCoverage = candidate => {
    const boundarySeconds = finiteNonNegative(
      recoveryPositionSeconds(candidate), 'recoveryPositionSeconds(candidate)',
    );
    const committed = coveringBufferedRange(
      commonCommittedRanges(queues, ['video', 'audio']),
      boundarySeconds, RECOVERY_TOLERANCE_SECONDS,
    );
    const buffered = coveringBufferedRange(
      commonBufferedRanges(queues, ['video', 'audio']),
      boundarySeconds, RECOVERY_TOLERANCE_SECONDS,
    );
    return {boundarySeconds, committed, buffered, covered: Boolean(committed && buffered)};
  };

  const cancelAutomaticRecovery = (reason, resumeSupply = false) => {
    if (!activeRecovery) return false;
    const cancelled = activeRecovery;
    activeRecovery = null;
    const resumeGeneration = ++generation;
    const generationFence = Promise.resolve().then(() =>
      demuxer.setMseRecoveryGeneration?.(BigInt(resumeGeneration)));
    void generationFence.catch(error => record(
      'recovery-generation-sync-failed', error?.message ?? String(error),
    ));
    wake(reason);
    record('recovery-cancelled', `${reason}:${cancelled.episodeId}`);
    if (resumeSupply) {
      const resume = () => {
        if (!isCurrent(resumeGeneration) || state === 'finalizing' || state === 'ended' ||
            state === 'cancelled' || state === 'failed') return;
        transition('supplying', `recovery-cancelled:${reason}`);
        feedPromise = supply(resumeGeneration);
        void feedPromise.catch(() => {});
      };
      void Promise.allSettled([lastRecoveryPromise, generationFence]).then(resume);
    } else if (reason === 'source-eof' || reason === 'eof') {
      const finish = () => {
        if (!isCurrent(resumeGeneration) || state === 'ended' || state === 'cancelled' ||
            state === 'failed') return;
        void finalization(resumeGeneration).catch(error => {
          if (!isCurrent(resumeGeneration)) return;
          transition('failed', error?.message ?? String(error));
          completion?.reject(error);
        });
      };
      void Promise.allSettled([lastRecoveryPromise, generationFence]).then(finish);
    }
    return true;
  };

  const applyRecoveryAvState = candidate => {
    if (candidate.type === 'recovery-state' && candidate.state === 'held-audio') {
      if (tracks.includes('video')) {
        heldAudioTracks = [...tracks];
        tracks = ['audio'];
        entryTimeSeconds = Number(media.currentTime);
        wake('held-audio');
      }
      return;
    }
    if (heldAudioTracks && candidate.state === 'restoring' &&
        candidate.avState === 'held-audio') {
      tracks = heldAudioTracks;
      heldAudioTracks = null;
      entryTimeSeconds = Number(media.currentTime);
      wake('av-restored');
    }
  };

  const runRecovery = async (candidate, selectedGeneration, previousFeed) => {
    let recoveryBytesRead = 0n;
    let recoveryReadOffset = candidate.restartOffset;
    const fail = (reason, cause = null) => {
      throw new MseRecordedRecoveryError(reason, snapshot(reason), cause);
    };
    try {
      await previousFeed;
      ensureCurrent(selectedGeneration);
      await syncRecoveryGeneration(selectedGeneration);
      transition('recovering', 'recovery-reposition');
      let coverage = recoveryCoverage(candidate);
      let landing = null;
      if (!coverage.covered) {
        if (typeof landRecovery !== 'function') fail('landing-unavailable');
        if (candidate.restartOffset >= source.size) fail('restart-offset-out-of-range');
        await demuxer.reposition(candidate.restartOffset, true);
        ensureCurrent(selectedGeneration);
        offset = candidate.restartOffset;
        const recoverySource = {
          get size() { return source.size; },
          async read(readOffset, requestedLength) {
            ensureCurrent(selectedGeneration);
            const requestedOffset = BigInt(readOffset);
            if (requestedOffset !== recoveryReadOffset) fail('nonsequential-landing-read');
            const remaining = RECOVERY_MAX_READ_BYTES - recoveryBytesRead;
            if (remaining <= 0n) fail('budget-exhausted');
            const length = BigInt(requestedLength);
            const authorizedLength = length < remaining ? length : remaining;
            if (authorizedLength <= 0n) fail('budget-exhausted');
            const data = await source.read(requestedOffset, authorizedLength);
            ensureCurrent(selectedGeneration);
            if (!(data instanceof Uint8Array)) fail('invalid-source-read');
            if (BigInt(data.byteLength) > authorizedLength) fail('source-read-overrun');
            if (!data.byteLength) fail('source-ended');
            recoveryBytesRead += BigInt(data.byteLength);
            recoveryReadOffset += BigInt(data.byteLength);
            return data;
          },
        };
        const recoveryDemuxer = new Proxy(demuxer, {
          get(target, property) {
            const value = target[property];
            if (typeof value !== 'function') return value;
            if (property === 'reposition') {
              return async () => fail('multiple-reposition');
            }
            return async (...args) => {
              ensureCurrent(selectedGeneration);
              const result = await value.apply(target, args);
              ensureCurrent(selectedGeneration);
              return result;
            };
          },
        });
        landing = await landRecovery({
          candidate, targetTimeSeconds: coverage.boundarySeconds,
          generation: selectedGeneration, source: recoverySource,
          demuxer: recoveryDemuxer, maxReadBytes: RECOVERY_MAX_READ_BYTES,
          signal: {
            get aborted() { return !isCurrent(selectedGeneration); },
            addEventListener() {},
            removeEventListener() {},
          },
        });
        ensureCurrent(selectedGeneration);
        if ((landing?.landingMode !== undefined && landing.landingMode !== 'exact') ||
            (landing?.landingMode === undefined && landing?.exact !== true)) {
          fail('landing-not-exact');
        }
        const recoveryQueues = ['video', 'audio'].map(type => queues.get(type));
        if (recoveryQueues.some(queue => !queue || typeof queue.waitIdle !== 'function')) {
          fail('landing-queue-unavailable');
        }
        await Promise.all(recoveryQueues.map(queue => queue.waitIdle()));
        ensureCurrent(selectedGeneration);
        coverage = recoveryCoverage(candidate);
        if (!coverage.covered) fail('landing-not-committed');
        if (landing?.nextOffset !== undefined) {
          offset = bigintNonNegative(landing.nextOffset, 'landing.nextOffset');
        } else {
          offset = candidate.restartOffset + recoveryBytesRead;
        }
        bytesRead += recoveryBytesRead;
      }
      ensureCurrent(selectedGeneration);
      media.currentTime = coverage.boundarySeconds;
      if (heldAudioTracks) {
        tracks = heldAudioTracks;
        heldAudioTracks = null;
        entryTimeSeconds = coverage.boundarySeconds;
      }
      activeRecovery = null;
      transition('supplying', coverage.covered && landing === null
        ? 'recovery-cache-hit' : 'recovery-landed');
      feedPromise = supply(selectedGeneration);
      void feedPromise.catch(() => {});
      return {
        candidate, cacheHit: landing === null, repositioned: landing !== null,
        bytesRead: recoveryBytesRead, boundarySeconds: coverage.boundarySeconds,
      };
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrent(selectedGeneration)) return null;
      activeRecovery = null;
      const failure = error instanceof MseRecordedRecoveryError ? error
        : new MseRecordedRecoveryError('landing-failed', snapshot(), error);
      transition('failed', failure.reason);
      completion?.reject(failure);
      throw failure;
    }
  };

  const scheduleRecovery = candidate => {
    applyRecoveryAvState(candidate);
    if (candidate.type !== 'recovery-candidate' || candidate.state !== 'restoring' ||
        candidate.avState !== 'stalled' || candidate.exact !== true) return false;
    if (state === 'idle' || state === 'finalizing' || state === 'ended' ||
        state === 'cancelled' || state === 'failed' || activeRecovery ||
        media.paused === true) return false;
    if (candidate.generation !== BigInt(generation)) {
      record('recovery-rejected', 'stale-generation');
      return false;
    }
    const episodeKey = `${generation}:${String(candidate.episodeId)}`;
    if (claimedRecoveryEpisodes.has(episodeKey)) return false;
    claimedRecoveryEpisodes.add(episodeKey);
    const previousFeed = feedPromise;
    const selectedGeneration = ++generation;
    activeRecovery = {
      episodeId: candidate.episodeId,
      generation: selectedGeneration,
    };
    wake('recovery-generation');
    const pending = serialize(() => runRecovery(candidate, selectedGeneration, previousFeed));
    lastRecoveryPromise = pending;
    void pending.catch(() => {});
    return true;
  };

  const locate = async (targetTimeSeconds, selectedGeneration, seeking) => {
    transition('locating-entry', 'entry-requested');
    if (typeof locateEntry !== 'function') return null;
    transition('supplying', 'entry-source-read');
    const entry = await locateEntry({
      targetTimeSeconds,
      seeking,
      generation: selectedGeneration,
      source: gatedSource(selectedGeneration),
      demuxer: gatedDemuxer(selectedGeneration),
      signal: {
        get aborted() { return !isCurrent(selectedGeneration); },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    ensureCurrent(selectedGeneration);
    if (entry?.nextOffset !== undefined) offset = BigInt(entry.nextOffset);
    if (entry?.bytesRead !== undefined) bytesRead += BigInt(entry.bytesRead);
    activeEntry = entry;
    return entry;
  };

  const finalization = async selectedGeneration => {
    transition('finalizing', 'true-eof');
    ensureCurrent(selectedGeneration);
    await demuxer.flush?.();
    ensureCurrent(selectedGeneration);
    checkError();
    await demuxer.finalizeIndex?.();
    ensureCurrent(selectedGeneration);
    const finalQueues = tracks.map(type => {
      const queue = queues.get(type);
      if (!queue || typeof queue.waitIdle !== 'function') {
        throw new MseRecordedPlaybackError(
          `Required ${type} queue is unavailable at Recorded EOF.`, snapshot(),
        );
      }
      return queue;
    });
    await Promise.all(finalQueues.map(queue => queue.waitIdle()));
    ensureCurrent(selectedGeneration);
    const result = await finalize({generation: selectedGeneration, offset, bytesRead});
    ensureCurrent(selectedGeneration);
    transition('ended', 'end-of-stream');
    completion?.resolve(result);
    return result;
  };

  const supply = async selectedGeneration => {
    try {
      while (isCurrent(selectedGeneration) && offset < source.size) {
        const reason = drainReason();
        if (reason !== null) {
          transition('draining', reason);
          progressReason = reason;
          await waitForProgress(selectedGeneration);
          continue;
        }
        transition('supplying', 'below-recorded-resume-water');
        const readOffset = offset;
        const length = source.size - readOffset < readSize
          ? source.size - readOffset : readSize;
        const data = await gatedSource(selectedGeneration).read(readOffset, length);
        if (!data.byteLength) {
          throw new MseRecordedPlaybackError(
            `The recording ended before its authoritative size at ${readOffset}.`, snapshot(),
          );
        }
        await demuxer.setMsePlaybackPosition?.(
          BigInt(Math.round(Number(media.currentTime) * 1000000)),
        );
        ensureCurrent(selectedGeneration);
        if (!await gatedDemuxer(selectedGeneration).push(data)) {
          throw new MseRecordedPlaybackError(
            `The demuxer rejected input at ${readOffset}.`, snapshot(),
          );
        }
        ensureCurrent(selectedGeneration);
        checkError();
        const lengthRead = BigInt(data.byteLength);
        offset += lengthRead;
        bytesRead += lengthRead;
        onProgress(snapshot('source-read'));
      }
      if (!isCurrent(selectedGeneration)) return null;
      return finalization(selectedGeneration);
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrent(selectedGeneration)) return null;
      transition('failed', error?.message ?? String(error));
      const failure = error instanceof MseRecordedPlaybackError || error?.code ? error
        : new MseRecordedPlaybackError(error?.message ?? String(error), snapshot(), error);
      completion?.reject(failure);
      throw failure;
    }
  };

  const replaceGeneration = (targetTimeSeconds, seeking) => {
    const target = finiteNonNegative(targetTimeSeconds, 'targetTimeSeconds');
    cancelAutomaticRecovery(seeking ? 'explicit-seek' : 'new-start');
    const previousFeed = feedPromise;
    const selectedGeneration = ++generation;
    const pending = serialize(async () => {
      entryTimeSeconds = target;
      entryToleranceSeconds = seeking ? 0.000002 : 0.05;
      wake(seeking ? 'seek-generation' : 'start-generation');
      await previousFeed;
      ensureCurrent(selectedGeneration);
      await syncRecoveryGeneration(selectedGeneration);
      transition(seeking ? 'seeking' : 'preparing', seeking ? 'explicit-seek' : 'start');
      const entry = await locate(target, selectedGeneration, seeking);
      ensureCurrent(selectedGeneration);
      transition('supplying', entry ? 'entry-located' : 'sequential-entry');
      feedPromise = supply(selectedGeneration);
      void feedPromise.catch(() => {});
      return entry;
    }).catch(error => {
      if (error?.name === 'AbortError') throw error;
      transition('failed', error?.message ?? String(error));
      completion?.reject(error);
      throw error;
    });
    return pending;
  };

  return {
    get state() { return state; },
    get generation() { return generation; },
    get offset() { return offset; },
    get bytesRead() { return bytesRead; },
    get entry() { return activeEntry; },
    get entryTimeSeconds() { return entryTimeSeconds; },
    get requiredTracks() { return [...tracks]; },
    get recoveryActive() { return activeRecovery !== null; },
    setRequiredTracks(nextRequiredTracks, nextEntryTimeSeconds = media.currentTime) {
      cancelAutomaticRecovery('track-selection', true);
      tracks = normalizeRequiredTracks(nextRequiredTracks);
      if (Number.isFinite(nextEntryTimeSeconds) && nextEntryTimeSeconds >= 0) {
        entryTimeSeconds = nextEntryTimeSeconds;
      }
      wake('required-tracks-changed');
      return [...tracks];
    },
    entryRange() {
      return coveringRange(queues, entryTimeSeconds, entryToleranceSeconds, tracks) ?? null;
    },
    entryCovered() { return this.entryRange() !== null; },
    commonAhead() {
      return commonBufferedAhead(media, queues, entryToleranceSeconds, tracks);
    },
    diagnostics() { return {current: snapshot(), history: history.map(item => ({...item}))}; },
    notifyUpdateEnd() { wake('updateend'); },
    notifyBufferedChange() { wake('buffered-change'); },
    notifyMediaTimeChange() { wake('media-time-change'); },
    waitForRecovery() { return lastRecoveryPromise; },
    submitEvent(event) {
      record('external-event', event?.type ?? 'unknown-event');
      const candidate = recoveryCandidate(event);
      if (candidate) scheduleRecovery(candidate);
      if (RECOVERY_CANCELLATION_EVENTS.has(event?.type)) {
        cancelAutomaticRecovery(event.type,
          event.type !== 'source-eof' && event.type !== 'eof');
      }
      wake(event?.type ?? 'external-event');
      return snapshot(event?.type ?? 'external-event');
    },
    start(targetTimeSeconds = 0) {
      const result = createCompletion();
      void replaceGeneration(targetTimeSeconds, false).catch(error => {
        if (error?.name !== 'AbortError') result.reject(error);
      });
      return result.promise;
    },
    seek(targetTimeSeconds) {
      createCompletion();
      return replaceGeneration(targetTimeSeconds, true);
    },
    async cancel() {
      cancelAutomaticRecovery('cancelled');
      generation += 1;
      await demuxer.setMseRecoveryGeneration?.(BigInt(generation));
      wake('cancelled');
      await feedPromise?.catch(() => {});
      transition('cancelled', 'cancelled');
      completion?.resolve(null);
    },
  };
}
