import {MseAppendQueue} from './mse-append-queue.mjs';
import {createMseOutputPipeline} from './mse-output-pipeline.mjs';
import {
  MsePlaybackMode,
  createMsePlaybackFlowControl,
} from './mse-playback.mjs?v=recorded-seek-concealment-v1';

const TRANSITION_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;

export function createLiveMseTransitionManager({
  MediaSourceClass,
  media,
  queueOptions,
  isActive,
  openMediaSource,
  commit,
  appendLog,
  liveMode = true,
  duration = Infinity,
  prepareCandidate = null,
  createProbeMedia = () => document.createElement('video'),
  mountProbeMedia = probeMedia => document.body.append(probeMedia),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  queueFactory = (type, init, onUpdateEnd, options, mediaSource, mediaElement) =>
    new MseAppendQueue(mediaSource, mediaElement, init.mime, onUpdateEnd, options),
}) {
  const latestInits = new Map();
  let candidate = null;
  let generation = 0;
  let playbackPaused = Boolean(media.paused);

  const discard = (discarded, error) => {
    if (!discarded) return;
    discarded.resumeWaiter?.reject(error);
    discarded.resumeWaiter = null;
    for (const queue of discarded.queues?.values?.() ?? []) queue.destroy(error);
    if (discarded.frameCallback !== null &&
        typeof discarded.probeMedia.cancelVideoFrameCallback === 'function') {
      discarded.probeMedia.cancelVideoFrameCallback(discarded.frameCallback);
    }
    discarded.probeMedia.pause();
    discarded.probeMedia.removeAttribute('src');
    discarded.probeMedia.load();
    discarded.probeMedia.remove();
    if (discarded.url) revokeObjectURL(discarded.url);
    discarded.cleanup?.();
    discarded.reject?.(error);
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
    const pending = candidate.pending?.reduce(
      (sum, item) => sum + (item.value?.data?.byteLength ?? 0), 0,
    ) ?? 0;
    if (queued + pending > TRANSITION_QUEUE_LIMIT_BYTES) {
      discardCandidate(new Error('Live MSE transition exceeded its 4 MiB queue limit.'));
    }
  };

  const checkReady = async () => {
    const current = candidate;
    if (!current || !current.pipeline || !current.prepared || current.committing || playbackPaused ||
        media.paused || !isActive()) return;
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
        current.probeMedia.currentTime = Math.max(current.target, authoritativeTime, range.start);
        await current.probeMedia.play();
        presentedTime = await presented;
      } else {
        current.probeMedia.currentTime = Math.max(current.target, authoritativeTime, range.start);
        await current.probeMedia.play();
      }
      if (candidate !== current || playbackPaused || media.paused || !isActive()) {
        current.committing = false;
        current.probeMedia.pause();
        return;
      }
      // Keep the candidate MediaElement attached. Detaching its object URL
      // runs the MSE detach algorithm, which clears both SourceBuffer lists.
      // The consumer atomically promotes this already-proven element instead.
      candidate = null;
      current.presentedTime = presentedTime;
      await commit(current);
      current.cleanup?.();
      current.cleanup = null;
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
      if (candidate?.pipeline) candidate.pipeline.onMseInit(init);
      else candidate?.pending.push({kind: 'init', value: init});
    },
    observeSegment(segment) {
      if (!candidate) return;
      try {
        if (candidate.pipeline) candidate.pipeline.onMseSegment(segment);
        else candidate.pending.push({kind: 'segment', value: segment});
        checkQueueLimit();
      } catch (error) {
        discardCandidate(error);
      }
    },
    observeSplice(type, splice) {
      if (!candidate) return;
      try {
        if (!candidate.pipeline) candidate.pending.push({kind: `splice-${type}`, value: splice});
        else if (type === 'video') candidate.pipeline.onMseVideoSplice(splice);
        else candidate.pipeline.onMseAudioSplice(splice);
        checkQueueLimit();
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
      let resolve;
      let reject;
      const completion = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      candidate = {
        id, mode, target, probeMedia, completion, resolve, reject,
        pending: [], queues: new Map(), pipeline: null, committing: false,
        frameCallback: null, url: null, cleanup: null, resumeWaiter: null,
        prepared: prepareCandidate === null,
      };
      const openingCandidate = candidate;
      let opened;
      try {
        opened = await openMediaSource(
          MediaSourceClass, probeMedia, {
            waitUntilPlaybackResumed() {
              if (!playbackPaused && !media.paused) return Promise.resolve();
              return new Promise((accept, decline) => {
                openingCandidate.resumeWaiter = {resolve: accept, reject: decline};
              });
            },
          },
        );
      } catch (error) {
        if (candidate?.id === id) discardCandidate(error);
        return completion;
      }
      if (!isActive() || id !== generation) {
        const error = new DOMException('Transition superseded.', 'AbortError');
        if (candidate?.id === id) discardCandidate(error);
        else {
          probeMedia.pause();
          probeMedia.removeAttribute('src');
          probeMedia.load();
          probeMedia.remove();
          revokeObjectURL(opened.url);
        }
        return completion;
      }
      const current = candidate;
      if (!current || current.id !== id) {
        revokeObjectURL(opened.url);
        return completion;
      }
      current.mediaSource = opened.mediaSource;
      current.url = opened.url;
      try {
        opened.mediaSource.duration = duration;
        const queues = current.queues;
        const flow = createMsePlaybackFlowControl({
          media: probeMedia,
          queues,
          requiredTracks,
          entryKind: liveMode ? 'live' : 'seek',
          entryTimeSeconds: target,
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
        Object.assign(current, opened, {flow, pipeline});
        for (const type of requiredTracks) {
          const init = latestInits.get(type);
          if (init) pipeline.onMseInit(init);
        }
        for (const item of current.pending.splice(0)) {
          if (item.kind === 'init') continue;
          if (item.kind === 'segment') pipeline.onMseSegment(item.value);
          else if (item.kind === 'splice-video') pipeline.onMseVideoSplice(item.value);
          else if (item.kind === 'splice-audio') pipeline.onMseAudioSplice(item.value);
        }
        appendLog(`${liveMode ? 'Live' : '録画'} ${mode === MsePlaybackMode.AUDIO_ONLY ? '純音声' : 'A/V'} ` +
          '候補 MediaSource を有界に準備します');
        if (prepareCandidate) {
          void Promise.resolve(prepareCandidate(current)).then(() => {
            if (candidate !== current) return;
            current.prepared = true;
            void checkReady();
          }).catch(error => {
            if (candidate === current) discardCandidate(error);
          });
        }
      } catch (error) {
        if (candidate === current) discardCandidate(error);
        return completion;
      }
      void checkReady();
      return completion;
    },
    notifyPlaybackPaused() {
      playbackPaused = true;
      if (!candidate) return;
      // Keep an in-flight RVFC proof attached to this candidate. Cancelling it
      // would strand the original promise and allow resume to create a second
      // proof for the same transaction.
      candidate.probeMedia.pause();
    },
    notifyPlaybackResumed() {
      playbackPaused = false;
      if (!media.paused && candidate?.resumeWaiter) {
        candidate.resumeWaiter.resolve();
        candidate.resumeWaiter = null;
      }
      if (candidate?.committing) {
        const current = candidate;
        void current.probeMedia.play().catch(error => {
          if (candidate === current) discardCandidate(error);
        });
        return;
      }
      void checkReady();
    },
    destroy() {
      generation += 1;
      const error = new DOMException('Transition stopped.', 'AbortError');
      if (candidate) discardCandidate(error);
      latestInits.clear();
    },
  };
}

export function promoteMseCandidateMedia({
  previousMedia,
  candidateMedia,
  restoreFocus = typeof document !== 'undefined' && document.activeElement === previousMedia,
  rebind = () => {},
}) {
  candidateMedia.removeAttribute('aria-hidden');
  candidateMedia.removeAttribute('style');
  candidateMedia.controls = previousMedia.controls;
  candidateMedia.muted = previousMedia.muted;
  candidateMedia.volume = previousMedia.volume;
  candidateMedia.defaultPlaybackRate = previousMedia.defaultPlaybackRate;
  candidateMedia.playbackRate = previousMedia.playbackRate;
  const id = previousMedia.id;
  previousMedia.removeAttribute('id');
  candidateMedia.id = id;
  previousMedia.replaceWith(candidateMedia);
  if (restoreFocus) candidateMedia.focus({preventScroll: true});
  rebind(candidateMedia, previousMedia);
  return candidateMedia;
}
