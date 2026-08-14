import {
  intersectBufferedRanges,
  nextBufferedRange,
} from '../mse-append-queue.mjs?v=gap-recovery-v2';

export function commonBufferedRanges(queues) {
  let common = null;
  for (const queue of queues.values()) {
    const ranges = queue.bufferedRanges();
    common = common === null ? ranges : intersectBufferedRanges(common, ranges);
    if (!common.length) break;
  }
  return common ?? [];
}

export function createMseGapRecovery({
  media,
  queues,
  liveMode = false,
  liveStartupBufferSeconds = 0.5,
  isActive = () => true,
  seek,
}) {
  let waiting = false;
  const recoveryRange = (ranges, currentTime, minimumDuration) => {
    const regular = nextBufferedRange(ranges, currentTime, minimumDuration);
    if (regular) return regular;
    // Chromium can report the current time as buffered even when the decoder
    // cannot cross a damaged RAP dependency inside that range. A real waiting
    // event is stronger evidence than the optimistic buffered range: if a
    // later common A/V range exists, skip to it instead of remaining stuck in
    // DEMUXER_UNDERFLOW forever.
    return ranges.find(range =>
      range.start > currentTime + 0.05 &&
      range.end - range.start >= minimumDuration) ?? null;
  };

  const update = () => {
    if (!waiting || !isActive() || queues.size < 2 || media.seeking || media.paused) {
      return null;
    }
    const minimumDuration = liveMode ? liveStartupBufferSeconds : 0.5;
    const next = recoveryRange(
      commonBufferedRanges(queues), media.currentTime, minimumDuration);
    if (!next) return null;

    const previousTime = media.currentTime;
    waiting = false;
    seek(next.start, previousTime);
    media.play().catch(() => {});
    return next;
  };

  return {
    notifyWaiting() {
      waiting = true;
      return update();
    },
    update,
  };
}
