import {
  commonBufferedRanges,
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
}
  from '../mse-playback.mjs?v=unified-av-recovery-v1';
import {commonCommittedRanges} from '../mse-playback-buffer.mjs';
import {createMseRecordedPlaybackController}
  from '../mse-recorded-playback.mjs?v=recorded-controller-v1';
export {createMseRecordedPlaybackController};

/**
 * Provides the small entry/range surface used by the demo before its Recorded
 * controller is constructed.  Once bound, every decision is delegated to the
 * Recorded controller; this module never imports Live flow or transition code.
 */
export function createRecordedPlaybackFlowBinding({
  media,
  queues,
  requiredTracks = ['video', 'audio'],
  entryTimeSeconds = 0,
}) {
  let controller = null;
  let tracks = [...requiredTracks];
  let entryTime = entryTimeSeconds;
  const fallbackRange = () => commonBufferedRanges(queues, tracks).find(range =>
    range.start <= entryTime + 0.05 && range.end >= entryTime,
  ) ?? null;
  return {
    bind(nextController) {
      controller = nextController;
      controller.setRequiredTracks(tracks, entryTime);
      return controller;
    },
    get requiredTracks() { return controller?.requiredTracks ?? [...tracks]; },
    get entryTimeSeconds() { return controller?.entryTimeSeconds ?? entryTime; },
    setRequiredTracks(nextTracks, nextEntryTime = media.currentTime) {
      tracks = [...new Set(nextTracks)];
      if (Number.isFinite(nextEntryTime) && nextEntryTime >= 0) entryTime = nextEntryTime;
      return controller?.setRequiredTracks(tracks, entryTime) ?? [...tracks];
    },
    entryRange() { return controller?.entryRange() ?? fallbackRange(); },
    entryCovered() { return controller?.entryCovered() ?? fallbackRange() !== null; },
    commonAhead() {
      if (controller) return controller.commonAhead();
      const range = fallbackRange();
      return range ? Math.max(0, range.end - media.currentTime) : 0;
    },
    async afterPush() {
      return {commonAhead: this.commonAhead(), entryCovered: this.entryCovered()};
    },
  };
}

export function createRecordedEntryLocator({
  durationUs,
  presentationStartUs,
  presentationEndUs,
  media,
  queues,
  requiredTracks,
  isActive,
  headReady,
  initialTracks = () => [],
  timelineEstablished = () => false,
  candidateTrack,
  trackPriority,
  activateVideoTrack,
  beforeLanding,
  checkError,
  onSession,
  onProgress,
  onComplete,
}) {
  return async ({targetTimeSeconds, seeking = false, source, demuxer, signal}) => {
    if (targetTimeSeconds === 0 && !seeking) return null;
    const seekFlowControl = createMsePlaybackFlowControl({
      media,
      queues,
      requiredTracks,
      entryKind: 'seek',
      entryTimeSeconds: targetTimeSeconds,
      allowNaturalStart: targetTimeSeconds === 0,
    });
    const session = createMseRecordedSeekSession({
      targetTimeSeconds, source, durationUs, presentationStartUs,
      presentationEndUs, demuxer, media, queues, flowControl: seekFlowControl, signal,
      isActive: () => isActive() && !signal.aborted,
      requiredTracks, headReady, candidateTrack, trackPriority,
      initialTracks: initialTracks(),
      timelineEstablished: timelineEstablished(),
      activateVideoTrack,
      beforeLanding: (...args) => beforeLanding(targetTimeSeconds, ...args),
      waitForAppends: () => Promise.all(
        [...queues.values()].map(queue => queue.waitStable()),
      ),
      checkError,
      onProgress,
    });
    onSession(session);
    const result = await session.run();
    onComplete(result, targetTimeSeconds);
    return result;
  };
}

export function createRecordedSeekConcealmentLogger({
  targetSeconds, presentationStartUs, appendLog,
}) {
  let damageStartUs = null;
  return event => {
    if (event.phase === 'observation-started') {
      damageStartUs = BigInt(event.presentationTimeUs);
    } else if (event.phase === 'stable-rap-committed' && damageStartUs !== null) {
      const sourceTargetUs = BigInt(presentationStartUs) + BigInt(
        Math.round(targetSeconds * 1000000));
      const stableRapUs = BigInt(event.presentationTimeUs);
      if (damageStartUs <= sourceTargetUs && sourceTargetUs < stableRapUs) {
        appendLog(`目標 ${targetSeconds.toFixed(3)}s は静止画で填補しました`);
      }
      damageStartUs = null;
    }
  };
}

export function createRecordedRecoveryLanding({
  queues, checkError, chunkBytes = 1024 * 1024,
}) {
  return async ({candidate, targetTimeSeconds: target, source, demuxer, maxReadBytes, signal}) => {
    const covered = ranges => ranges.some(range =>
      range.start <= target + 0.000002 && range.end >= target + 0.000002);
    let offset = BigInt(candidate.restartOffset);
    let bytesRead = 0n;
    await demuxer.beginMseRecordedSeek?.();
    try {
      while (!signal.aborted && bytesRead < maxReadBytes) {
        const remaining = maxReadBytes - bytesRead;
        const length = remaining < BigInt(chunkBytes) ? remaining : BigInt(chunkBytes);
        const data = await source.read(offset, length);
        if (!data.byteLength) break;
        if (!await demuxer.push(data)) throw new Error('Recorded recovery demux failed.');
        offset += BigInt(data.byteLength);
        bytesRead += BigInt(data.byteLength);
        await demuxer.flushMseRecordedSeekAudio?.();
        await Promise.all([...queues.values()].map(queue => queue.waitIdle?.() ?? queue.waitStable()));
        checkError();
        if (covered(commonCommittedRanges(queues, ['video', 'audio'])) &&
            covered(commonBufferedRanges(queues, ['video', 'audio']))) {
          await demuxer.finishMseRecordedSeek?.(
            BigInt(Math.round(target * 1000000)),
          );
          return {landingMode: 'exact', nextOffset: offset};
        }
      }
      throw new Error('Recorded recovery did not commit exact common A/V within 64 MiB.');
    } catch (error) {
      await demuxer.cancelMseRecordedSeek?.();
      throw error;
    }
  };
}

export function createMseVideoRecoveryLogger({
  observeConcealment, submitRecordedEvent = () => {}, appendLog,
}) {
  return event => {
    submitRecordedEvent({type: 'video-recovery', detail: event});
    observeConcealment(event);
    const label = {
      'observation-started': '映像復旧観察開始',
      'candidate-rejected': '後続損傷で映像復旧候補を否決',
      'stable-rap-committed': '安定RAPを映像出力へコミット',
    }[event.phase];
    if (label) {
      appendLog(`${label} PTS=${(Number(event.presentationTimeUs) / 1000000).toFixed(6)}s`);
    }
  };
}
