import {
  ENTRY_TOLERANCE_SECONDS,
  commonCommittedRanges,
  commonBufferedAhead,
  commonBufferedRanges,
  coveringBufferedRange,
  coveringRange,
  normalizeRequiredTracks,
  selectRequiredQueues,
} from './mse-playback-buffer.mjs';
import {
  MSE_SEEK_READ_BUDGET_BYTES,
  MseRecordedSupplyError,
  MseStartupBufferError,
} from './mse-playback-contract.mjs';

const HELD_FRAME_AUDIO_TAIL_SECONDS = 0.512;

export function createMsePlaybackFlowControl({
  media,
  queues,
  requiredTracks = ['video', 'audio'],
  entryKind = 'startup',
  entryTimeSeconds = entryKind === 'startup' ? 0 : media.currentTime,
  entryToleranceSeconds = entryKind === 'seek' ? 0.000002 : ENTRY_TOLERANCE_SECONDS,
  browserBoundaryToleranceSeconds = ENTRY_TOLERANCE_SECONDS,
  highSeconds = 15,
  lowSeconds = 8,
  startupNoProgressBytes = MSE_SEEK_READ_BUDGET_BYTES,
  queueHighBytes = 4 * 1024 * 1024,
  backBufferSeconds = 3,
}) {
  if (entryKind !== 'startup' && entryKind !== 'live' && entryKind !== 'seek') {
    throw new TypeError(`Unknown MSE playback entry kind: ${entryKind}`);
  }
  let startupBytes = 0;
  let entryCovered = false;
  let state = entryKind === 'seek' ? 'feeding' : 'priming';
  let sourceOffset = 0n;
  let lastFragmentOffset = null;
  let lastFragmentBytes = 0;
  let lastProgressAtMilliseconds = Date.now();
  let terminalError = null;
  let currentRequiredTracks = normalizeRequiredTracks(requiredTracks);
  const stateWaiters = new Set();
  const requiredQueues = () => selectRequiredQueues(queues, currentRequiredTracks);
  const playbackRate = () => Number.isFinite(media.playbackRate) && media.playbackRate > 0
    ? media.playbackRate : 1;
  const highWatermarkSeconds = () => highSeconds * playbackRate();
  const lowWatermarkSeconds = () => lowSeconds * playbackRate();
  const waitForStateChange = () => new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stateWaiters.delete(finish);
      resolve();
    };
    stateWaiters.add(finish);
  });

  const trim = () => {
    for (const queue of requiredQueues().values()) {
      // Once appendBuffer has proved the browser's quota ceiling, every newly
      // presented safe boundary is relevant.  The ordinary trim granularity is
      // deliberately bypassed only while the exact failed fragment is held;
      // otherwise high-bitrate recordings can consume their entire entry
      // buffer before the next coarse trim is allowed.
      if (typeof queue.trimBackBuffer === 'function') {
        queue.trimBackBuffer(queue.quotaBlocked === true);
      }
      else queue.trimBefore(media.currentTime - backBufferSeconds);
    }
  };
  const queuedBytes = queue => Number.isFinite(queue.queuedBytes)
    ? Math.max(0, queue.queuedBytes) : 0;
  const throwQueueError = () => {
    for (const queue of requiredQueues().values()) {
      if (queue.error) {
        if (queue.error.code === 'MSE_RECORDED_SUPPLY_STALLED') {
          queue.error.diagnostics = {
            ...snapshot(),
            queueFailure: queue.error.diagnostics,
          };
        }
        throw queue.error;
      }
    }
  };
  const wakeStateWaiters = () => {
    const pending = [...stateWaiters];
    stateWaiters.clear();
    for (const resolve of pending) resolve();
  };
  const queueDetails = () => Object.fromEntries([...requiredQueues()].map(([track, queue]) => [
    track, queue.diagnostics?.() ?? null,
  ]));
  const quotaObserved = () => [...requiredQueues().values()].some(queue =>
    (queue.quotaExceededCount ?? queue.diagnostics?.().quotaExceededCount ?? 0) > 0);
  const snapshot = () => ({
    state,
    sourceOffset: String(sourceOffset),
    lastFragmentOffset: lastFragmentOffset === null ? null : String(lastFragmentOffset),
    lastFragmentBytes,
    commonAhead: api.commonAhead(),
    entryRange: api.entryRange(),
    currentTime: Number.isFinite(media.currentTime) ? media.currentTime : null,
    presentedTimes: Object.fromEntries(Object.entries(queueDetails()).map(([track, detail]) => [
      track, detail?.backBufferReferenceTime ?? null,
    ])),
    playbackRate: playbackRate(),
    quotaObserved: quotaObserved(),
    queues: queueDetails(),
    millisecondsSinceProgress: Math.max(0, Date.now() - lastProgressAtMilliseconds),
  });
  const liveEntryRange = () => commonBufferedRanges(queues, currentRequiredTracks).find(range =>
    range.end > media.currentTime + 0.001) ?? null;
  const seekEntryRange = () => {
    const committed = coveringBufferedRange(
      commonCommittedRanges(queues, currentRequiredTracks),
      entryTimeSeconds,
      entryToleranceSeconds,
    );
    if (!committed) return null;
    const buffered = commonBufferedRanges(queues, currentRequiredTracks).find(range =>
      range.start <= entryTimeSeconds + browserBoundaryToleranceSeconds &&
      range.end >= entryTimeSeconds &&
      range.start < committed.end && range.end > committed.start);
    return buffered ? committed : null;
  };
  // This is deliberately narrower than normal seek coverage.  It accepts only
  // a native-emitted video sample that covers the requested clock and a short
  // AAC tail that ends immediately before it; createMseRecordedSeekSession()
  // additionally requires native held-frame evidence before committing it.
  const heldFrameEntryRange = () => {
    if (entryKind !== 'seek' || !currentRequiredTracks.includes('video') ||
        !currentRequiredTracks.includes('audio')) return null;
    const video = queues.get('video');
    const audio = queues.get('audio');
    if (!video || !audio) return null;
    const videoCommitted = coveringBufferedRange(
      video.committedRanges?.() ?? [], entryTimeSeconds, entryToleranceSeconds,
    );
    if (!videoCommitted) return null;
    const videoBuffered = (video.bufferedRanges?.() ?? []).find(range =>
      range.start <= entryTimeSeconds + browserBoundaryToleranceSeconds &&
      range.end >= entryTimeSeconds && range.start < videoCommitted.end &&
      range.end > videoCommitted.start);
    if (!videoBuffered) return null;
    const audioTail = (audio.committedRanges?.() ?? []).find(range =>
      range.start <= entryTimeSeconds && range.end < entryTimeSeconds &&
      range.end >= entryTimeSeconds - HELD_FRAME_AUDIO_TAIL_SECONDS);
    if (!audioTail) return null;
    const audioBuffered = (audio.bufferedRanges?.() ?? []).find(range =>
      range.start < audioTail.end && range.end > audioTail.start);
    return audioBuffered ? videoCommitted : null;
  };

  const api = {
    entryKind,
    get entryTimeSeconds() { return entryTimeSeconds; },
    get requiredTracks() { return [...currentRequiredTracks]; },
    highWatermarkSeconds,
    lowWatermarkSeconds,
    startupMinimumSeconds() { return 0.5 * playbackRate(); },
    get state() { return state; },
    diagnostics: snapshot,
    noteSourceFragment(offset, byteLength) {
      lastFragmentOffset = BigInt(offset);
      lastFragmentBytes = byteLength;
    },
    noteSourceProgress(nextOffset) {
      sourceOffset = BigInt(nextOffset);
      lastProgressAtMilliseconds = Date.now();
    },
    canStartFreshRecorded() {
      if (!api.entryCovered()) return false;
      const ahead = api.commonAhead();
      return ahead >= highWatermarkSeconds() ||
        (quotaObserved() && ahead >= api.startupMinimumSeconds());
    },
    queuePressure() {
      return {
        limitBytes: queueHighBytes,
        tracks: Object.fromEntries([...requiredQueues()].map(([track, queue]) => [
          track, queuedBytes(queue),
        ])),
        details: queueDetails(),
      };
    },
    notifyBufferedChange() {
      trim();
      if (state === 'rebuffering' && api.commonAhead() > 0) state = 'feeding';
      wakeStateWaiters();
    },
    notifyRateChange() {
      wakeStateWaiters();
    },
    notifyWaiting() {
      const blockedWithoutReclaim = [...requiredQueues().values()].some(queue =>
        queue.quotaBlocked && !queue.canReclaimBackBuffer?.());
      if (state === 'quota-wait' && blockedWithoutReclaim) {
        terminalError = new MseRecordedSupplyError(
          'Quota-limited playback exhausted common A/V before safe presented history existed.',
          snapshot(),
        );
        state = 'error';
        wakeStateWaiters();
      }
      if (state === 'feeding' && api.commonAhead() < lowWatermarkSeconds()) {
        state = 'rebuffering';
      }
      return snapshot();
    },
    end() {
      state = 'ended';
      wakeStateWaiters();
    },
    fail(error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
      state = 'error';
      wakeStateWaiters();
    },
    setRequiredTracks(nextRequiredTracks, nextEntryTimeSeconds = media.currentTime) {
      currentRequiredTracks = normalizeRequiredTracks(nextRequiredTracks);
      if (Number.isFinite(nextEntryTimeSeconds) && nextEntryTimeSeconds >= 0) {
        entryTimeSeconds = nextEntryTimeSeconds;
      }
      entryCovered = false;
      startupBytes = 0;
      if (state !== 'ended' && state !== 'error') {
        state = entryKind === 'seek' ? 'feeding' : 'priming';
      }
      return [...currentRequiredTracks];
    },
    entryRange() {
      if (entryKind === 'live') return liveEntryRange();
      if (entryKind === 'seek') return seekEntryRange();
      return coveringRange(
        queues, entryTimeSeconds, entryToleranceSeconds, currentRequiredTracks,
      );
    },
    heldFrameEntryRange() {
      return heldFrameEntryRange();
    },
    entryCovered() {
      return entryCovered || api.entryRange() !== null;
    },
    commonAhead() {
      if (entryKind === 'live') {
        const range = liveEntryRange();
        return range ? Math.max(0, range.end - Math.max(media.currentTime, range.start)) : 0;
      }
      return commonBufferedAhead(
        media, queues, entryToleranceSeconds, currentRequiredTracks,
      );
    },
    async afterPush(byteLength, isActive = () => true) {
      if (terminalError) throw terminalError;
      trim();
      throwQueueError();
      const quotaBlocked = [...requiredQueues().values()].filter(queue => queue.quotaBlocked);
      if (quotaBlocked.length) {
        state = 'quota-wait';
        for (const queue of quotaBlocked) {
          if (queue.error) throw queue.error;
          if (typeof queue.waitQuotaResolved !== 'function') {
            throw new MseRecordedSupplyError(
              'A quota-blocked queue cannot prove completion of safe reclamation.', snapshot());
          }
        }
        while (isActive() && quotaBlocked.some(queue => queue.quotaBlocked &&
          !queue.canReclaimBackBuffer?.())) {
          if (!api.canStartFreshRecorded()) {
            throw new MseRecordedSupplyError(
              'Quota was reached before a playable entry or safe presented history existed.',
              snapshot(),
            );
          }
          await waitForStateChange();
          if (terminalError) throw terminalError;
          trim();
        }
        await Promise.all(quotaBlocked.map(queue => queue.waitQuotaResolved()));
        throwQueueError();
        if (state !== 'ended' && state !== 'error') state = entryCovered ? 'feeding' : 'priming';
      }
      await Promise.all([...requiredQueues().values()].map(
        queue => queue.waitFlowControlled(queueHighBytes),
      ));
      throwQueueError();
      if (!isActive()) return {commonAhead: 0, entryCovered};

      const range = api.entryRange();
      if (range) {
        entryCovered = true;
        if (state === 'priming' && api.canStartFreshRecorded()) state = 'feeding';
      } else if (!entryCovered) {
        if (entryKind === 'startup' || entryKind === 'live') startupBytes += byteLength;
        if ((entryKind === 'startup' || entryKind === 'live') &&
            startupBytes >= startupNoProgressBytes) {
          throw new MseStartupBufferError(
            entryKind === 'live'
              ? `${startupNoProgressBytes} bytes were read without forming a common live A/V range.`
              : `${startupNoProgressBytes} bytes were read without forming a common A/V range at timestamp 0.`);
        }
      }

      let ahead = api.commonAhead();
      if (!entryCovered || ahead < highWatermarkSeconds()) {
        return {commonAhead: ahead, entryCovered, state};
      }
      let throttledPlaybackRate = playbackRate();
      while (isActive() && ahead >= lowWatermarkSeconds()) {
        trim();
        await waitForStateChange();
        if (terminalError) throw terminalError;
        throwQueueError();
        ahead = api.commonAhead();
        const currentPlaybackRate = playbackRate();
        if (currentPlaybackRate !== throttledPlaybackRate) {
          throttledPlaybackRate = currentPlaybackRate;
          if (ahead < highWatermarkSeconds()) break;
        }
      }
      if (state !== 'ended' && state !== 'error') state = 'feeding';
      return {commonAhead: ahead, entryCovered, state};
    },
  };
  return api;
}
