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
  const damageLeadToleranceSeconds = 2;
  let waiting = false;
  const damageIntervals = [];
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
    const ranges = commonBufferedRanges(queues);
    const knownDamage = damageIntervals.find(damage =>
      damage.start <= media.currentTime + damageLeadToleranceSeconds &&
      media.currentTime < damage.recovery - 0.05);
    const damageRange = knownDamage && ranges.find(range =>
      range.start <= knownDamage.recovery + 0.05 &&
      range.end - knownDamage.recovery >= minimumDuration);
    const next = damageRange
      ? { start: Math.max(damageRange.start, knownDamage.recovery), end: damageRange.end }
      : recoveryRange(ranges, media.currentTime, minimumDuration);
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
    reportDamage(damage) {
      if (damage.action !== 'seek' || damage.recoveryTimeUs === null) return;
      const start = Number(damage.startTimeUs ?? damage.endTimeUs) / 1000000;
      const recovery = Number(damage.recoveryTimeUs) / 1000000;
      if (!Number.isFinite(start) || !Number.isFinite(recovery) || recovery <= start) return;
      damageIntervals.push({ start, recovery });
      damageIntervals.sort((left, right) => left.start - right.start);
      if (damageIntervals.length > 64) damageIntervals.splice(0, damageIntervals.length - 64);
      update();
    },
    update,
  };
}
