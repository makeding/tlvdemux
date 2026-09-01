/**
 * Coordinates the demo's browser events with the SDK-owned common A/V supply
 * controller.  It deliberately owns no read loop: demand only wakes the loop
 * already blocked by flow control.
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
      flow?.notifyDemand();
      flow = null;
      maybeStart = null;
    },
    canStartFreshRecorded({liveMode, startTimeSeconds, reuseMedia, playbackFlow}) {
      return liveMode || startTimeSeconds !== 0 || reuseMedia ||
        playbackFlow.commonAhead() >= playbackFlow.highWatermarkSeconds();
    },
    notifyWaiting() {
      if (!flow) return null;
      const ahead = flow.commonAhead();
      const low = flow.lowWatermarkSeconds();
      if (ahead < low) flow.notifyDemand();
      return {ahead, low, pressure: flow.queuePressure()};
    },
    notifyBufferedChange() {
      flow?.notifyDemand();
      maybeStart?.();
    },
    notifyRateChange() {
      flow?.notifyDemand();
      maybeStart?.();
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
