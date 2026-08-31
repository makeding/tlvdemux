export function bufferedAhead(media) {
  const ranges = media.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= media.currentTime + 0.1 && ranges.end(index) >= media.currentTime) {
      return ranges.end(index) - media.currentTime;
    }
  }
  return 0;
}

export function monitorDemoPlaybackQuality({
  media, isActive, onDroppedFrames, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  if (typeof media.getVideoPlaybackQuality !== 'function') return () => {};
  let previous = media.getVideoPlaybackQuality();
  const timer = setIntervalFn(() => {
    if (!isActive()) return clearIntervalFn(timer);
    const current = media.getVideoPlaybackQuality();
    const dropped = current.droppedVideoFrames - previous.droppedVideoFrames;
    const total = current.totalVideoFrames - previous.totalVideoFrames;
    if (dropped > 0) onDroppedFrames({dropped, total, ahead: bufferedAhead(media)});
    previous = current;
  }, 5000);
  return () => clearIntervalFn(timer);
}
