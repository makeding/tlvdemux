import {
  intersectBufferedRanges,
  nextBufferedRange,
} from '../mse-append-queue.mjs?v=gap-recovery-v1';

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

  const update = () => {
    if (!waiting || !isActive() || queues.size < 2 || media.seeking || media.paused) {
      return null;
    }
    const minimumDuration = liveMode ? liveStartupBufferSeconds : 0;
    const next = nextBufferedRange(
      commonBufferedRanges(queues), media.currentTime, minimumDuration,
    );
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
