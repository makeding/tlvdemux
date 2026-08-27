export {commonBufferedRanges} from './mse-playback-flow-control.mjs?v=startup-buffer-v1';
import {commonBufferedRanges} from './mse-playback-flow-control.mjs?v=startup-buffer-v1';

/**
 * Starts playback once both tracks cover a common range. Recorded playback
 * keeps the caller's requested position even when the first range begins
 * later; only the existing live-start policy may align to that range.
 */
export function startMsePlayback({
  media,
  queues,
  liveMode = false,
  minimumLiveBufferSeconds = 0,
  play = () => media.play(),
}) {
  const ranges = commonBufferedRanges(queues);
  if (!ranges.length) return null;
  const currentTime = media.currentTime;
  const range = liveMode
    ? ranges.find(item => item.end > currentTime + 0.001)
    : ranges.find(item => item.start <= currentTime + 0.05 &&
        item.end > currentTime + 0.001);
  if (!range) return null;
  const commonAhead = range.end - Math.max(currentTime, range.start);
  if (liveMode && commonAhead < minimumLiveBufferSeconds) return null;
  const aligned = liveMode && currentTime < range.start - 0.001;
  if (aligned) media.currentTime = range.start;
  return {range, commonAhead, aligned, playResult: play()};
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
