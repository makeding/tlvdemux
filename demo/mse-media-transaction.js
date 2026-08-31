export function createMediaElementProxy(getMedia) {
  return {
    get currentTime() { return getMedia().currentTime; },
    set currentTime(value) { getMedia().currentTime = value; },
    get paused() { return getMedia().paused; },
    get seeking() { return getMedia().seeking; },
    get ended() { return getMedia().ended; },
    get error() { return getMedia().error; },
    get buffered() { return getMedia().buffered; },
    get videoFrameCallbackSupported() {
      return typeof getMedia().requestVideoFrameCallback === 'function';
    },
    play() { return getMedia().play(); },
    pause() { return getMedia().pause(); },
    requestVideoFrameCallback(callback) {
      const media = getMedia();
      return {media, id: media.requestVideoFrameCallback(callback)};
    },
    cancelVideoFrameCallback(request) {
      request?.media?.cancelVideoFrameCallback?.(request.id);
    },
  };
}

export function formatBytes(value) {
  const byteCount = typeof value === 'bigint' ? value : BigInt(value);
  if (byteCount < 1024n) return `${byteCount} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = Number(byteCount);
  let unit = -1;
  do { scaled /= 1024; unit += 1; } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}
