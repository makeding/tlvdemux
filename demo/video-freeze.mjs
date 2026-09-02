/**
 * Keeps the last presented picture visible while a Recorded seek is proving
 * its replacement A/V pair. The slot is permanent; only its pixels and hidden
 * state change, so seeking never rebuilds the media-plane geometry.
 */
export function createVideoFreeze({video, canvas, renderedFrameSource = null}) {
  const context = canvas.getContext('2d', {alpha: false});
  let active = false;
  let hasFrame = false;
  let frameRequest = null;
  let pendingReleaseTarget = null;
  let latestRenderedMediaTime = null;

  const remember = source => {
    // `video.seeking` becomes true as soon as native controls change the
    // timeline, before the JavaScript seeking listener necessarily runs.
    if (!active && !video.seeking) {
      const width = source === video ? video.videoWidth : source.width;
      const height = source === video ? video.videoHeight : source.height;
      if (context && video.readyState >= 2 && width > 0 && height > 0) {
        canvas.width = width;
        canvas.height = height;
        context.drawImage(source, 0, 0, width, height);
        hasFrame = true;
      }
    }
  };
  const rememberRawFrame = () => {
    if (!renderedFrameSource?.hasActivePresentation) remember(video);
  };
  const forgetRenderedFrame = renderedFrameSource?.onRenderedFrame?.(
    ({source, mediaTime}) => {
      if (Number.isFinite(mediaTime)) latestRenderedMediaTime = mediaTime;
      if (!active) {
        remember(source);
        return;
      }
      if (pendingReleaseTarget === null || video.seeking ||
          !Number.isFinite(mediaTime) ||
          Math.abs(mediaTime - pendingReleaseTarget) > 0.1) return;
      canvas.hidden = true;
      active = false;
      pendingReleaseTarget = null;
    },
  ) ?? (() => {});
  const requestFrame = () => {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    frameRequest = video.requestVideoFrameCallback(() => {
      rememberRawFrame();
      requestFrame();
    });
  };
  requestFrame();

  return {
    capture() {
      if (active) return true;
      pendingReleaseTarget = null;
      if (!hasFrame) {
        const rendered = renderedFrameSource?.activeCanvas;
        if (renderedFrameSource?.hasActivePresentation) {
          if (rendered) remember(rendered);
        } else {
          remember(video);
        }
      }
      if (!hasFrame && context && video.videoWidth > 0 && video.videoHeight > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.fillStyle = '#080b09';
        context.fillRect(0, 0, canvas.width, canvas.height);
        hasFrame = true;
      }
      if (!hasFrame) return false;
      canvas.hidden = false;
      active = true;
      return true;
    },
    release() {
      canvas.hidden = true;
      active = false;
      pendingReleaseTarget = null;
    },
    releaseAfterPresentation(targetTimeSeconds) {
      if (!active) return;
      if (!renderedFrameSource?.hasActivePresentation) {
        this.release();
        return;
      }
      pendingReleaseTarget = targetTimeSeconds;
      if (!video.seeking && Number.isFinite(latestRenderedMediaTime) &&
          Math.abs(latestRenderedMediaTime - targetTimeSeconds) <= 0.1) {
        canvas.hidden = true;
        active = false;
        pendingReleaseTarget = null;
      }
    },
    destroy() {
      if (frameRequest !== null) video.cancelVideoFrameCallback?.(frameRequest);
      frameRequest = null;
      canvas.hidden = true;
      active = false;
      hasFrame = false;
      pendingReleaseTarget = null;
      latestRenderedMediaTime = null;
      forgetRenderedFrame();
    },
    get active() { return active; },
  };
}
