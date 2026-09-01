import {
  ENTRY_TOLERANCE_SECONDS,
  commonBufferedAhead,
  commonBufferedRanges,
  commonCommittedRanges,
  coveringBufferedRange,
  coveringRange,
  normalizeRequiredTracks,
  selectRequiredQueues,
} from './mse-playback-buffer.mjs';
import {
  MSE_SEEK_READ_BUDGET_BYTES,
  MseStartupBufferError,
} from './mse-playback-contract.mjs';

export function createMsePlaybackFlowControl({
  media,
  queues,
  requiredTracks = ['video', 'audio'],
  entryKind = 'startup',
  entryTimeSeconds = entryKind === 'startup' ? 0 : media.currentTime,
  entryToleranceSeconds = entryKind === 'seek' ? 0.000002 : ENTRY_TOLERANCE_SECONDS,
  browserBoundaryToleranceSeconds = ENTRY_TOLERANCE_SECONDS,
  allowNaturalStart = false,
  highSeconds = 15,
  lowSeconds = 8,
  startupNoProgressBytes = MSE_SEEK_READ_BUDGET_BYTES,
  queueHighBytes = 4 * 1024 * 1024,
  backBufferSeconds = 8,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (entryKind !== 'startup' && entryKind !== 'live' && entryKind !== 'seek') {
    throw new TypeError(`Unknown MSE playback entry kind: ${entryKind}`);
  }
  let startupBytes = 0;
  let committedLandingMode = null;
  let currentRequiredTracks = normalizeRequiredTracks(requiredTracks);
  const requiredQueues = () => selectRequiredQueues(queues, currentRequiredTracks);

  const trim = () => {
    for (const queue of requiredQueues().values()) {
      queue.trimBefore(media.currentTime - backBufferSeconds);
    }
  };
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
  const naturalStartRange = () => {
    if (!allowNaturalStart || entryKind !== 'seek' || entryTimeSeconds !== 0 ||
        currentRequiredTracks.length !== 2 ||
        !currentRequiredTracks.includes('video') ||
        !currentRequiredTracks.includes('audio')) return null;
    const video = queues.get('video');
    const audio = queues.get('audio');
    if (!video || !audio) return null;
    const audioCommitted = coveringBufferedRange(
      audio.committedRanges?.() ?? [], 0, entryToleranceSeconds,
    );
    const audioBuffered = coveringBufferedRange(
      audio.bufferedRanges?.() ?? [], 0, browserBoundaryToleranceSeconds,
    );
    if (!audioCommitted || !audioBuffered) return null;
    const videoCommitted = (video.committedRanges?.() ?? [])
      .filter(range => range.end > range.start && range.start >= 0)
      .sort((left, right) => left.start - right.start)[0];
    if (!videoCommitted || audioCommitted.end < videoCommitted.start) return null;
    const videoBuffered = (video.bufferedRanges?.() ?? []).find(range =>
      range.start < videoCommitted.end && range.end > videoCommitted.start);
    return videoBuffered ? {start: 0, end: Math.min(audioCommitted.end, videoCommitted.end)} : null;
  };
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
      range.end >= entryTimeSeconds - 0.25);
    if (!audioTail) return null;
    const audioBuffered = (audio.bufferedRanges?.() ?? []).find(range =>
      range.start < audioTail.end && range.end > audioTail.start);
    return audioBuffered ? videoCommitted : null;
  };
  const detectedLandingMode = () => {
    if (entryKind !== 'seek') return null;
    if (seekEntryRange()) return 'exact';
    return naturalStartRange() ? 'natural-start' : null;
  };

  const api = {
    entryKind,
    get entryTimeSeconds() { return entryTimeSeconds; },
    get requiredTracks() { return [...currentRequiredTracks]; },
    setRequiredTracks(nextRequiredTracks, nextEntryTimeSeconds = media.currentTime) {
      currentRequiredTracks = normalizeRequiredTracks(nextRequiredTracks);
      if (Number.isFinite(nextEntryTimeSeconds) && nextEntryTimeSeconds >= 0) {
        entryTimeSeconds = nextEntryTimeSeconds;
      }
      committedLandingMode = null;
      startupBytes = 0;
      return [...currentRequiredTracks];
    },
    entryRange() {
      if (entryKind === 'live') return liveEntryRange();
      if (entryKind === 'seek') return seekEntryRange() ?? naturalStartRange();
      return coveringRange(
        queues, entryTimeSeconds, entryToleranceSeconds, currentRequiredTracks,
      );
    },
    landingMode() {
      return committedLandingMode ?? detectedLandingMode();
    },
    heldFrameEntryRange() {
      return heldFrameEntryRange();
    },
    entryCovered() {
      return api.landingMode() !== null || api.entryRange() !== null;
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
      trim();
      await Promise.all([...requiredQueues().values()].map(
        queue => queue.waitFlowControlled(queueHighBytes),
      ));
      if (!isActive()) return {commonAhead: 0, entryCovered: api.entryCovered()};

      const mode = detectedLandingMode();
      if (mode) {
        committedLandingMode = mode;
      } else if (!committedLandingMode) {
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
      if (!api.entryCovered() || ahead < highSeconds) {
        return {commonAhead: ahead, entryCovered: api.entryCovered()};
      }
      while (isActive() && ahead > lowSeconds) {
        trim();
        await wait(250);
        ahead = api.commonAhead();
      }
      return {commonAhead: ahead, entryCovered: api.entryCovered()};
    },
  };
  return api;
}
