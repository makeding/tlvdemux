import {promoteMseCandidateMedia}
  from '../mse-live-transition.mjs?v=recorded-seek-entry-fence-v2';

export function createMediaElementProxy(getMedia) {
  return {
    get currentTime() { return getMedia().currentTime; },
    set currentTime(value) { getMedia().currentTime = value; },
    get playbackRate() { return getMedia().playbackRate; },
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

export function onceMediaEvent(target, event) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error(`${event} に失敗しました`)); };
    const cleanup = () => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
    };
    target.addEventListener(event, done, {once: true});
    target.addEventListener('error', failed, {once: true});
  });
}

export async function openDetachedMseMedia(
  MediaSourceClass,
  mediaElement,
  {waitUntilPlaybackResumed = async () => {}} = {},
) {
  const mediaSource = new MediaSourceClass();
  const opened = mediaSource.readyState === 'open'
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, {once: true});
      mediaSource.addEventListener('sourceclose', () =>
        reject(new Error('MediaSource closed before opening.')), {once: true});
    });
  const url = URL.createObjectURL(mediaSource);
  if (typeof globalThis.ManagedMediaSource === 'function' &&
      mediaSource instanceof globalThis.ManagedMediaSource) {
    mediaElement.disableRemotePlayback = true;
  }
  mediaElement.src = url;
  mediaElement.load();
  try {
    if (typeof globalThis.ManagedMediaSource === 'function' &&
        mediaSource instanceof globalThis.ManagedMediaSource) {
      await waitUntilPlaybackResumed();
      await mediaElement.play();
    }
    await opened;
  } catch (error) {
    mediaElement.pause();
    mediaElement.removeAttribute('src');
    mediaElement.load();
    URL.revokeObjectURL(url);
    throw error;
  }
  return {mediaSource, url};
}

export async function commitDemoMseCandidate({
  candidate,
  sourceLabel,
  previousMedia,
  previousUrl,
  previousQueues,
  liveMode,
  beforeCommit,
  rebind,
  install,
  createSubtitleRenderer,
  gapRecovery,
  transitionManagers,
  onQueueUpdate,
  appendLog,
  assertCurrent = () => {},
}) {
  assertCurrent();
  // The RAP/held frame only provides decodable media; it never replaces the
  // explicit user clock installed on the promoted MediaElement.
  const target = candidate.seekResult?.requestedTimeSeconds ??
    candidate.intentTarget ?? candidate.target ?? previousMedia.currentTime;
  if (previousMedia.paused) {
    throw new DOMException('Transition paused by the user.', 'AbortError');
  }
  await beforeCommit(candidate, previousMedia);
  assertCurrent();
  for (const queue of previousQueues.values()) queue.destroy();
  assertCurrent();
  previousMedia.pause();
  const promotedMedia = promoteMseCandidateMedia({
    previousMedia, candidateMedia: candidate.probeMedia, rebind,
  });
  createSubtitleRenderer(liveMode);
  assertCurrent();
  gapRecovery.notifyMediaElementChanged();
  install(candidate);
  assertCurrent();
  for (const queue of candidate.queues.values()) {
    queue.onUpdateEnd = onQueueUpdate;
    queue.resume();
  }
  promotedMedia.currentTime = target;
  assertCurrent();
  if (!promotedMedia.paused) {
    gapRecovery.notifyPlaybackResumed();
    for (const manager of transitionManagers) manager?.notifyPlaybackResumed();
  }
  previousMedia.removeAttribute('src');
  previousMedia.load();
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  appendLog(`${sourceLabel} ${candidate.mode === 'audio-only' ? '純音声' : 'A/V'} ` +
    'MediaSource へ原子切替しました');
}
