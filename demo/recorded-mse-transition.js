import {
  MsePlaybackMode,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs?v=recorded-transition-v1';
import {createLiveMseTransitionManager}
  from '../mse-live-transition.mjs?v=recorded-transition-v1';

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
      let callbackError = null;
      let demuxer = null;
      candidate.cleanup = () => {
        abort.abort();
        demuxer?.delete();
        demuxer = null;
      };

      const videoPacketId = selectedVideoPacketId();
      const audioPacketId = selectedAudioPacketId();
      demuxer = new wasmModule.TlvDemuxer({
        mseMaxAudioChannels,
        onMseInit: init => manager.observeInit(init),
        onMseSegment: segment => manager.observeSegment(segment),
        onMseAudioSplice: splice => manager.observeSplice('audio', splice),
        onMseVideoSplice: splice => manager.observeSplice('video', splice),
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
      });

      await demuxer.configureTrackSelection({
        videoPacketId: videoPacketId ?? undefined,
        audioPacketId: audioPacketId ?? undefined,
      });
      await demuxer.setMseToneMappingMode(toneMappingMode());
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
