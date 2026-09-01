import {intersectBufferedRanges} from './mse-append-queue.mjs';

export const ENTRY_TOLERANCE_SECONDS = 0.05;

export function normalizeRequiredTracks(requiredTracks = ['video', 'audio']) {
  const tracks = [...new Set(requiredTracks)];
  if (!tracks.length || tracks.some(type => type !== 'video' && type !== 'audio')) {
    throw new TypeError('requiredTracks must contain audio and/or video.');
  }
  return tracks;
}

export function selectRequiredQueues(queues, requiredTracks) {
  const selected = new Map();
  for (const type of normalizeRequiredTracks(requiredTracks)) {
    const queue = queues.get(type);
    if (queue) selected.set(type, queue);
  }
  return selected;
}

export function commonBufferedRanges(queues, requiredTracks = ['video', 'audio']) {
  const tracks = normalizeRequiredTracks(requiredTracks);
  const selected = selectRequiredQueues(queues, tracks);
  if (selected.size !== tracks.length) return [];
  let common = null;
  for (const queue of selected.values()) {
    const ranges = queue.bufferedRanges();
    common = common === null ? ranges : intersectBufferedRanges(common, ranges);
    if (!common.length) break;
  }
  return common ?? [];
}

export function coveringRange(queues, timeSeconds, toleranceSeconds, requiredTracks) {
  return commonBufferedRanges(queues, requiredTracks).find(range =>
    range.start <= timeSeconds + toleranceSeconds && range.end >= timeSeconds) ?? null;
}

export function commonBufferedAhead(
  media, queues, toleranceSeconds = ENTRY_TOLERANCE_SECONDS,
  requiredTracks = ['video', 'audio'],
) {
  const range = coveringRange(queues, media.currentTime, toleranceSeconds, requiredTracks);
  return range ? Math.max(0, range.end - media.currentTime) : 0;
}

export function startMsePlayback({
  media,
  queues,
  liveMode = false,
  minimumLiveBufferSeconds = 0,
  requiredTracks = ['video', 'audio'],
  play = () => media.play(),
}) {
  const ranges = commonBufferedRanges(queues, requiredTracks);
  if (!ranges.length) return null;
  const currentTime = media.currentTime;
  const range = liveMode
    ? ranges.find(item => item.end > currentTime + 0.001)
    : ranges.find(item => item.start <= currentTime + ENTRY_TOLERANCE_SECONDS &&
        item.end > currentTime + 0.001);
  if (!range) return null;
  const commonAhead = range.end - Math.max(currentTime, range.start);
  if (liveMode && commonAhead < minimumLiveBufferSeconds) return null;
  const aligned = liveMode && currentTime < range.start - 0.001;
  if (aligned) media.currentTime = range.start;
  return {range, commonAhead, aligned, playResult: play()};
}
