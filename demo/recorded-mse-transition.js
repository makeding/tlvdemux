import {
  MsePlaybackMode,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs?v=recorded-seek-concealment-v1';
import {createLiveMseTransitionManager}
  from '../mse-live-transition.mjs?v=recorded-seek-concealment-v1';

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

export function createMseVideoRecoveryLogger({
  gapRecovery, observeConcealment, appendLog,
}) {
  return event => {
    gapRecovery.observeVideoRecoveryEvent(event);
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

export function createRecordedMseTransitionManager({
  wasmModule,
  MediaSourceClass,
  source,
  durationSeconds,
  durationUs,
  presentationStartUs,
  presentationEndUs,
  media,
  queueOptions,
  isActive,
  openMediaSource,
  commit,
  appendLog,
  selectedVideoPacketId,
  selectedAudioPacketId,
  toneMappingMode,
  cachedEstimateOffset = null,
  mseMaxAudioChannels = 6,
  createProbeMedia,
  mountProbeMedia,
  revokeObjectURL,
  queueFactory,
}) {
  let manager;
  manager = createLiveMseTransitionManager({
    MediaSourceClass,
    media,
    queueOptions,
    isActive,
    openMediaSource,
    commit,
    appendLog,
    liveMode: false,
    duration: durationSeconds,
    createProbeMedia,
    mountProbeMedia,
    revokeObjectURL,
    queueFactory,
    async prepareCandidate(candidate) {
      const abort = new AbortController();
      const tracks = new Map();
      let selectedVideo = null;
      let selectedAudio = null;
      let seekSession = null;
      const observeConcealment = createRecordedSeekConcealmentLogger({
        targetSeconds: candidate.target, presentationStartUs, appendLog,
      });
      let callbackError = null;
      let demuxer = null;
      candidate.cleanup = () => {
        abort.abort();
        demuxer?.delete();
        demuxer = null;
      };

      const videoPacketId = selectedVideoPacketId();
      const audioPacketId = selectedAudioPacketId();
      const demuxCallbacks = {
        mseMaxAudioChannels,
        onMseInit: init => manager.observeInit(init),
        onMseSegment: segment => manager.observeSegment(segment),
        onMseAudioSplice: splice => manager.observeSplice('audio', splice),
        onMseVideoSplice: splice => manager.observeSplice('video', splice),
        onMseVideoRecovery: observeConcealment,
        onTrack(track) {
          tracks.set(track.trackId, track);
          seekSession?.observeTrack(track);
          if (track.kind === 'video' &&
              (videoPacketId === null || track.packetId === videoPacketId) &&
              selectedVideo === null) {
            selectedVideo = track.trackId;
            void demuxer.selectTrack('video', selectedVideo);
          } else if (track.kind === 'audio' &&
                     (audioPacketId === null || track.packetId === audioPacketId) &&
                     selectedAudio === null) {
            selectedAudio = track.trackId;
            void demuxer.selectTrack('audio', selectedAudio);
          }
        },
        onTrackRemoved(track) {
          tracks.delete(track.trackId);
          seekSession?.observeTrackRemoved(track);
          if (selectedVideo === track.trackId) selectedVideo = null;
          if (selectedAudio === track.trackId) selectedAudio = null;
        },
        onPlaybackAccessUnitView(unit) {
          seekSession?.observeAccessUnit(unit);
        },
        onError(error) {
          if (!error.recoverable) callbackError = new Error(error.message);
        },
      };
      demuxer = new wasmModule.TlvDemuxer(demuxCallbacks);
      candidate.adoptDemuxer = callbacks => {
        if (!demuxer) throw new Error('Recorded seek demuxer is unavailable.');
        Object.assign(demuxCallbacks, callbacks);
        const adopted = demuxer;
        demuxer = null;
        candidate.cleanup = null;
        return {demuxer: adopted, tracks: [...tracks.values()]};
      };

      await demuxer.configureTrackSelection({
        videoPacketId: videoPacketId ?? undefined,
        audioPacketId: audioPacketId ?? undefined,
      });
      await demuxer.setMseToneMappingMode(toneMappingMode());
      await demuxer.setSubtitlePassthroughEnabled(true);
      await demuxer.setMseTimestampOffset(-BigInt(presentationStartUs));
      await demuxer.startIndex(false);

      const audioOnly = candidate.mode === MsePlaybackMode.AUDIO_ONLY;
      seekSession = createMseRecordedSeekSession({
        targetTimeSeconds: candidate.target,
        source,
        durationUs,
        presentationStartUs,
        presentationEndUs,
        demuxer,
        media: candidate.probeMedia,
        queues: candidate.queues,
        flowControl: candidate.flow,
        signal: abort.signal,
        isActive,
        requiredTracks: audioOnly ? ['audio'] : ['video', 'audio'],
        headReady: () => audioOnly
          ? selectedAudio !== null
          : selectedVideo !== null && selectedAudio !== null,
        candidateTrack: track => audioOnly
          ? track.kind === 'audio' && track.trackId === selectedAudio
          : track.kind === 'video' && track.trackId === selectedVideo,
        activateVideoTrack: async track => {
          if (audioOnly) {
            if (track?.trackId !== selectedAudio) {
              selectedAudio = track.trackId;
              await demuxer.selectTrack('audio', selectedAudio);
            }
          } else if (track?.trackId !== selectedVideo) {
            selectedVideo = track.trackId;
            await demuxer.selectTrack('video', selectedVideo);
          }
        },
        estimateOffset: cachedEstimateOffset,
        waitForAppends: () => candidate.pipeline.waitStable(),
        checkError: () => { if (callbackError) throw callbackError; },
      });
      for (const track of tracks.values()) seekSession.observeTrack(track);
      const result = await seekSession.run();
      candidate.seekResult = result;
      candidate.demuxer = demuxer;
      appendLog(`録画候補 seek ${candidate.target.toFixed(3)}s、` +
        `単一 budget ${Number(result.bytesRead) / (1024 * 1024)} MiB`);
    },
  });
  return manager;
}
