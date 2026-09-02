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

// AAC-LATM frames are 1024 samples (about 21.3 ms at 48 kHz).  A decoded
// video frame may begin just before the first AAC frame that can be appended;
// accept that one-frame audio preroll while still requiring video itself to
// cover the immutable seek target exactly.
const AAC_BOUNDARY_TOLERANCE_SECONDS = 0.022;

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
    const video = queues.get('video');
    const videoExact = currentRequiredTracks.includes('video') && video
      ? coveringBufferedRange(video.committedRanges?.() ?? [], entryTimeSeconds,
        entryToleranceSeconds)
      : null;
    // The common coded range is authoritative when it covers the target.  If
    // only its audio edge trails by one AAC frame, retain the exact video
    // requirement and use the bounded boundary tolerance for both coded and
    // browser-buffered intersections.  This rejects a later-only video entry
    // while accepting normal video/AAC timestamp quantization.
    const committedBoundary = committed ?? (
      currentRequiredTracks.length === 2 && videoExact
        ? coveringBufferedRange(
          commonCommittedRanges(queues, currentRequiredTracks),
          entryTimeSeconds, AAC_BOUNDARY_TOLERANCE_SECONDS)
        : null);
    if (!committedBoundary) return null;
    const buffered = commonBufferedRanges(queues, currentRequiredTracks).find(range =>
      range.start <= entryTimeSeconds + (committed ? browserBoundaryToleranceSeconds
        : AAC_BOUNDARY_TOLERANCE_SECONDS) &&
      range.end >= entryTimeSeconds &&
      range.start < committedBoundary.end && range.end > committedBoundary.start);
    return buffered ? committedBoundary : null;
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
      // Live A/V recovery has no byte- or callback-based terminal boundary.
      // While there is no playable required-track intersection, keep consuming
      // input so the remuxer can observe a later stable RAP/AAC pair. The core
      // withholds damaged/unverified GOPs, so there is no active MSE queue to
      // drain until a playable intersection exists again. Audio-only Live still
      // has an entry range and therefore retains normal bounded backpressure.
      if (entryKind !== 'live' || api.entryCovered()) {
        await Promise.all([...requiredQueues().values()].map(
          queue => queue.waitFlowControlled(queueHighBytes),
        ));
      }
      if (!isActive()) return {commonAhead: 0, entryCovered: api.entryCovered()};

      const mode = detectedLandingMode();
      if (mode) {
        committedLandingMode = mode;
      } else if (!committedLandingMode && entryKind === 'startup') {
        startupBytes += byteLength;
        if (startupBytes >= startupNoProgressBytes) {
          throw new MseStartupBufferError(
            `${startupNoProgressBytes} bytes were read without forming a common A/V range at timestamp 0.`);
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
