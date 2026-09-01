import {
  commonBufferedAhead,
  coveringRange,
  normalizeRequiredTracks,
} from './mse-playback-buffer.mjs';

export const MSE_RECORDED_SUPPLY_FAILED = 'MSE_RECORDED_SUPPLY_FAILED';
export const MSE_RECORDED_STATES = Object.freeze([
  'idle', 'preparing', 'locating-entry', 'supplying', 'draining',
  'finalizing', 'ended', 'seeking', 'cancelled', 'failed',
]);

const STATE_SET = new Set(MSE_RECORDED_STATES);
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_HIGH_SECONDS = 15;
const DEFAULT_LOW_SECONDS = 8;
const DEFAULT_DIAGNOSTIC_LIMIT = 64;
const DEFAULT_PROGRESS_POLL_MILLISECONDS = 250;

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
  let completion = null;
  let progressWaiter = null;
  let progressReason = null;
  let activeEntry = null;
  let entryTimeSeconds = 0;
  let entryToleranceSeconds = 0.05;
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
    operation = operation.then(async () => {
      generation += 1;
      const selectedGeneration = generation;
      entryTimeSeconds = target;
      entryToleranceSeconds = seeking ? 0.000002 : 0.05;
      wake(seeking ? 'seek-generation' : 'start-generation');
      await feedPromise;
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
    return operation;
  };

  return {
    get state() { return state; },
    get generation() { return generation; },
    get offset() { return offset; },
    get bytesRead() { return bytesRead; },
    get entry() { return activeEntry; },
    get entryTimeSeconds() { return entryTimeSeconds; },
    get requiredTracks() { return [...tracks]; },
    setRequiredTracks(nextRequiredTracks, nextEntryTimeSeconds = media.currentTime) {
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
    submitEvent(event) {
      record('external-event', event?.type ?? 'unknown-event');
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
      generation += 1;
      wake('cancelled');
      await feedPromise;
      transition('cancelled', 'cancelled');
      completion?.resolve(null);
    },
  };
}
