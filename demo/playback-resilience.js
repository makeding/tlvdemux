import {MsePlaybackMode} from '../mse-playback.mjs?v=unified-av-recovery-v1';

const MODE_SET = new Set(Object.values(MsePlaybackMode));

/**
 * Demo binding for the SDK-owned A/V evidence state machine. It never seeks,
 * replaces the MediaElement/MediaSource, reconnects input, or calls play().
 */
export function createDemoPlaybackResilience({
  media,
  liveMode,
  generation,
  expectedGeneration = () => generation,
  isActive,
  pipeline,
  playbackFlow,
  statusElement,
  playbackStateElement,
  appendLog,
  submitRecordedEvent,
  commitLiveTimestampOffset = () => {},
}) {
  let mode = MsePlaybackMode.STARTING;
  let paused = Boolean(media.paused);
  let pendingRestore = null;

  const setRequiredTracks = tracks => {
    pipeline()?.setRequiredTracks(tracks);
    playbackFlow().setRequiredTracks(tracks, media.currentTime);
  };
  const render = evidence => {
    mode = evidence.state;
    if (mode === MsePlaybackMode.HELD_AUDIO) {
      setRequiredTracks(['audio']);
      statusElement.textContent =
        '映像を復旧しています。最後の映像を保ったまま音声を継続します。 [TLV_VIDEO_UNAVAILABLE]';
      playbackStateElement.textContent = '映像復旧待ち（音声継続）';
    } else if (mode === MsePlaybackMode.STALLED) {
      setRequiredTracks(['video', 'audio']);
      statusElement.textContent =
        '映像と音声を復旧できる受信点を待っています。受信は継続しています。 [TLV_VIDEO_UNAVAILABLE]';
      playbackStateElement.textContent = liveMode ? 'Live 復旧待ち' : '録画復旧待ち';
    } else if (mode === MsePlaybackMode.SWITCHING) {
      statusElement.textContent = '利用可能な映像・音声へ切り替えています。';
    } else if (mode === MsePlaybackMode.RESTORING) {
      statusElement.textContent = '映像と音声を原位置で復旧しています。';
    } else if (mode === MsePlaybackMode.AV) {
      setRequiredTracks(['video', 'audio']);
      statusElement.textContent = '';
      playbackStateElement.textContent = liveMode ? 'Live 再生中' : '再生中';
    }
    appendLog(`A/V recovery state=${mode} episode=${String(evidence.episodeId)}`);
  };

  const spliceLiveAtAnchor = evidence => {
    const anchorUs = BigInt(Math.round(media.currentTime * 1000000));
    const videoSourceUs = BigInt(evidence.sourceRapTimeUs);
    const audioSourceUs = BigInt(evidence.commonAvBoundaryUs);
    const timestampOffsetUs = anchorUs - videoSourceUs;
    commitLiveTimestampOffset(timestampOffsetUs);
    pipeline()?.onMseVideoSplice({
      presentationTimeUs: videoSourceUs,
      timestampOffsetUs,
    });
    pipeline()?.onMseAudioSplice({
      presentationTimeUs: audioSourceUs,
      timestampOffsetUs,
    });
  };

  const commit = evidence => {
    if (!isActive() || paused || media.paused) {
      pendingRestore = evidence;
      return null;
    }
    if (liveMode) {
      try {
        spliceLiveAtAnchor(evidence);
      } catch (error) {
        pendingRestore = null;
        appendLog(`Live A/V recovery candidate rejected: ${error?.message ?? error}`);
        render({...evidence, state: MsePlaybackMode.STALLED});
        return null;
      }
    } else {
      if (!liveMode) submitRecordedEvent(evidence);
    }
    pendingRestore = null;
    render({...evidence, state: MsePlaybackMode.RESTORING});
    return evidence;
  };

  return {
    get mode() { return mode; },
    observeEvidence(evidence) {
      if (!evidence || !MODE_SET.has(evidence.state) ||
          Number(evidence.generation) !== Number(expectedGeneration())) return null;
      if (evidence.type === 'recovery-candidate' && evidence.exact === true) {
        return commit(evidence);
      }
      if (!liveMode) submitRecordedEvent(evidence);
      render(evidence);
      return evidence;
    },
    notifyLayerSwitchStarted() {
      render({state: MsePlaybackMode.SWITCHING, episodeId: 0});
    },
    notifyLayerSwitchCompleted() {
      render({state: MsePlaybackMode.AV, episodeId: 0});
    },
    notifyPlaybackPaused() { paused = true; },
    notifyPlaybackResumed() {
      paused = false;
      if (pendingRestore) commit(pendingRestore);
    },
    notifyExplicitSeek() { pendingRestore = null; },
    notifyTrackSwitch() { pendingRestore = null; },
    notifySourceEnded() { pendingRestore = null; },
    notifyBufferedChange() {},
    observeAccessUnit() {},
    reportDamage() {},
    observePresentedFrame() {},
    destroy() { pendingRestore = null; },
  };
}

export {MsePlaybackMode};
