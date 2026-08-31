/**
 * Coordinates the demo's browser events with the SDK-owned common A/V supply
 * controller. It does not authorize reads from MediaElement events.
 */
export function createMseSupplyCoordinator() {
  let flow = null;
  let maybeStart = null;
  return {
    install(nextFlow, nextMaybeStart = null) {
      flow = nextFlow;
      if (nextMaybeStart) maybeStart = nextMaybeStart;
    },
    release() {
      flow?.fail(new DOMException('Recorded supply released.', 'AbortError'));
      flow = null;
      maybeStart = null;
    },
    canStartFreshRecorded({liveMode, startTimeSeconds, reuseMedia, playbackFlow}) {
      return liveMode || startTimeSeconds !== 0 || reuseMedia ||
        playbackFlow.canStartFreshRecorded();
    },
    notifyWaiting() {
      if (!flow) return null;
      const ahead = flow.commonAhead();
      const low = flow.lowWatermarkSeconds();
      const snapshot = flow.notifyWaiting();
      return {ahead, low, state: snapshot.state, pressure: flow.queuePressure()};
    },
    notifyBufferedChange() {
      flow?.notifyBufferedChange();
      maybeStart?.();
      return flow?.state ?? null;
    },
    notifyRateChange() {
      flow?.notifyRateChange();
      maybeStart?.();
      return flow?.state ?? null;
    },
  };
}

export function describeRecordedSupplyStart(commonAhead, playbackRate, startupWatermarkSeconds) {
  return `録画共通バッファ ${commonAhead.toFixed(1)}s で再生開始 ` +
    `(${playbackRate}×, startup high=${startupWatermarkSeconds.toFixed(1)}s)`;
}

export async function activateManagedMediaSourceForBuffering(media, opened) {
  // WebKit requires a play request before ManagedMediaSource becomes active,
  // but that request must not become the recorded playback start.
  Promise.resolve(media.play()).catch(() => {});
  await opened;
  media.pause();
}
