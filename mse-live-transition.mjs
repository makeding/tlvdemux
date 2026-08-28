import {MseAppendQueue} from './mse-append-queue.mjs';
import {createMseOutputPipeline} from './mse-output-pipeline.mjs';
import {
  MsePlaybackMode,
  createMsePlaybackFlowControl,
} from './mse-playback.mjs';

const TRANSITION_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;

export function createLiveMseTransitionManager({
  MediaSourceClass,
  media,
  queueOptions,
  isActive,
  openMediaSource,
  commit,
  appendLog,
  createProbeMedia = () => document.createElement('video'),
  mountProbeMedia = probeMedia => document.body.append(probeMedia),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  queueFactory = (type, init, onUpdateEnd, options, mediaSource, mediaElement) =>
    new MseAppendQueue(mediaSource, mediaElement, init.mime, onUpdateEnd, options),
}) {
  const latestInits = new Map();
  let candidate = null;
  let generation = 0;

  const discard = (discarded, error) => {
    if (!discarded) return;
    for (const queue of discarded.queues.values()) queue.destroy(error);
    discarded.probeMedia.pause();
    discarded.probeMedia.removeAttribute('src');
    discarded.probeMedia.load();
    discarded.probeMedia.remove();
    revokeObjectURL(discarded.url);
    discarded.reject(error);
  };

  const discardCandidate = error => {
    const discarded = candidate;
    candidate = null;
    discard(discarded, error);
  };

  const checkQueueLimit = () => {
    if (!candidate) return;
    const queued = [...candidate.queues.values()]
      .reduce((sum, queue) => sum + queue.queuedBytes, 0);
    if (queued > TRANSITION_QUEUE_LIMIT_BYTES) {
      discardCandidate(new Error('Live MSE transition exceeded its 4 MiB queue limit.'));
    }
  };

  const checkReady = async () => {
    const current = candidate;
    if (!current || current.committing || !isActive()) return;
    const range = current.flow.entryRange();
    if (!range) return;
    const authoritativeTime = media.currentTime;
    if (!Number.isFinite(authoritativeTime) ||
        authoritativeTime > range.end - 0.001) return;
    current.committing = true;
    try {
      let presentedTime = null;
      if (current.mode === MsePlaybackMode.RESTORING_VIDEO) {
        const presented = new Promise((resolve, reject) => {
          if (typeof current.probeMedia.requestVideoFrameCallback !== 'function') {
            reject(new Error('Presented-frame observation is unavailable.'));
            return;
          }
          current.frameCallback = current.probeMedia.requestVideoFrameCallback((_now, metadata) => {
            const mediaTime = Number(metadata?.mediaTime);
            if (Number.isFinite(mediaTime) && mediaTime + 0.001 >= current.target) resolve(mediaTime);
            else reject(new Error('The candidate frame preceded its restore RAP.'));
          });
        });
        current.probeMedia.currentTime = Math.max(
          current.target, authoritativeTime, range.start,
        );
        await current.probeMedia.play();
        presentedTime = await presented;
      } else {
        current.probeMedia.currentTime = Math.max(
          current.target, authoritativeTime, range.start,
        );
        await current.probeMedia.play();
      }
      if (candidate !== current || !isActive()) return;
      // Keep the candidate MediaElement attached. Detaching its object URL
      // runs the MSE detach algorithm, which clears both SourceBuffer lists.
      // The consumer atomically promotes this already-proven element instead.
      candidate = null;
      await commit({...current, presentedTime});
      current.resolve({presentedTime});
    } catch (error) {
      if (candidate === current) {
        discardCandidate(error);
      } else {
        discard(current, error);
      }
    }
  };

  return {
    observeInit(init) {
      latestInits.set(init.type, init);
      candidate?.pipeline.onMseInit(init);
    },
    observeSegment(segment) {
      if (!candidate) return;
      try {
        candidate.pipeline.onMseSegment(segment);
        checkQueueLimit();
      } catch (error) {
        discardCandidate(error);
      }
    },
    observeSplice(type, splice) {
      if (!candidate) return;
      try {
        if (type === 'video') candidate.pipeline.onMseVideoSplice(splice);
        else candidate.pipeline.onMseAudioSplice(splice);
      } catch (error) {
        discardCandidate(error);
      }
    },
    async transition(mode, target) {
      if (candidate) discardCandidate(new DOMException('Transition superseded.', 'AbortError'));
      const requiredTracks = mode === MsePlaybackMode.AUDIO_ONLY
        ? ['audio'] : ['video', 'audio'];
      const id = ++generation;
      const probeMedia = createProbeMedia();
      probeMedia.muted = true;
      probeMedia.playsInline = true;
      probeMedia.setAttribute('aria-hidden', 'true');
      Object.assign(probeMedia.style, {
        position: 'fixed',
        width: '1px',
        height: '1px',
        left: '0',
        bottom: '0',
        opacity: '0.001',
        pointerEvents: 'none',
      });
      mountProbeMedia(probeMedia);
      const opened = await openMediaSource(MediaSourceClass, probeMedia);
      if (!isActive() || id !== generation) {
        revokeObjectURL(opened.url);
        throw new DOMException('Transition superseded.', 'AbortError');
      }
      opened.mediaSource.duration = Infinity;
      const queues = new Map();
      const flow = createMsePlaybackFlowControl({
        media: probeMedia,
        queues,
        requiredTracks,
        entryKind: 'live',
        entryTimeSeconds: target,
      });
      let resolve;
      let reject;
      const completion = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const pipeline = createMseOutputPipeline({
        mediaSource: opened.mediaSource,
        media: probeMedia,
        queues,
        requiredTracks,
        pendingBytesLimit: TRANSITION_QUEUE_LIMIT_BYTES,
        queueOptions: {...queueOptions, destroyOnSourceClose: false},
        queueFactory(type, init, onUpdateEnd, options) {
          return queueFactory(
            type, init,
            () => { onUpdateEnd?.(); void checkReady(); },
            options, opened.mediaSource, probeMedia,
          );
        },
      });
      candidate = {
        id,
        mode,
        target,
        ...opened,
        probeMedia,
        queues,
        flow,
        pipeline,
        completion,
        resolve,
        reject,
        committing: false,
        frameCallback: null,
      };
      for (const type of requiredTracks) {
        const init = latestInits.get(type);
        if (init) pipeline.onMseInit(init);
      }
      appendLog(`Live ${mode === MsePlaybackMode.AUDIO_ONLY ? '純音声' : 'A/V'} ` +
        '候補 MediaSource を有界に準備します');
      void checkReady();
      return completion;
    },
    destroy() {
      generation += 1;
      if (candidate) discardCandidate(new DOMException('Transition stopped.', 'AbortError'));
      latestInits.clear();
    },
  };
}
