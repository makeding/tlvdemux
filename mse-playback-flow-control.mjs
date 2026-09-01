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
  let entryCovered = false;
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
      range.end >= entryTimeSeconds - 0.25);
    if (!audioTail) return null;
    const audioBuffered = (audio.bufferedRanges?.() ?? []).find(range =>
      range.start < audioTail.end && range.end > audioTail.start);
    return audioBuffered ? videoCommitted : null;
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
      entryCovered = false;
      startupBytes = 0;
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
      trim();
      await Promise.all([...requiredQueues().values()].map(
        queue => queue.waitFlowControlled(queueHighBytes),
      ));
      if (!isActive()) return {commonAhead: 0, entryCovered};

      const range = api.entryRange();
      if (range) {
        entryCovered = true;
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
      if (!entryCovered || ahead < highSeconds) return {commonAhead: ahead, entryCovered};
      while (isActive() && ahead > lowSeconds) {
        trim();
        await wait(250);
        ahead = api.commonAhead();
      }
      return {commonAhead: ahead, entryCovered};
    },
  };
  return api;
}
