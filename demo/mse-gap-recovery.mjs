import {intersectBufferedRanges} from '../mse-append-queue.mjs?v=damage-recovery-v3';

export function commonBufferedRanges(queues) {
  let common = null;
  for (const queue of queues.values()) {
    const ranges = queue.bufferedRanges();
    common = common === null ? ranges : intersectBufferedRanges(common, ranges);
    if (!common.length) break;
  }
  return common ?? [];
}

/**
 * Applies only recovery positions explicitly published by the active core
 * tracker. MediaElement waiting and buffered ranges never select a target.
 */
export function createMseGapRecovery({
  media,
  isActive = () => true,
  isCurrentLayer = () => true,
  switchInFlight = () => false,
  seek,
}) {
  return {
    notifyWaiting() {
      return null;
    },
    reset() {},
    reportDamage(damage) {
      if (damage.action !== 'seek' || damage.recoveryTimeUs === null ||
          !isActive() || !isCurrentLayer(damage) || switchInFlight() ||
          media.seeking) return null;
      const target = Number(damage.recoveryTimeUs) / 1000000;
      if (!Number.isFinite(target) || target < 0) return null;
      const previousTime = media.currentTime;
      seek(target, previousTime);
      if (!media.paused) media.play().catch(() => {});
      return {start: target, end: target};
    },
  };
}
