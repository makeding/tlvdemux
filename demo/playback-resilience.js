import {
  MsePlaybackMode,
  createMsePlaybackResilienceController,
} from '../mse-playback.mjs?v=audio-only-resilience-v1';
import {setMseVideoTrackActive}
  from '../mse-output-pipeline.mjs?v=audio-only-resilience-v1';

export function createDemoPlaybackResilience({
  media,
  mediaSource,
  queues,
  playbackFlow,
  pipeline,
  presentationStartUs,
  generation,
  initialMode,
  liveMode,
  isActive,
  isCurrentLayer,
  switchInFlight,
  seek,
  statusElement,
  playbackStateElement,
  appendLog,
  scheduleRecordedRebuild,
  removeActiveVideoQueue,
}) {
  const renderMode = event => {
    if (event.mode === MsePlaybackMode.AUDIO_ONLY) {
      statusElement.textContent =
        '映像を復旧できないため、音声のみ再生しています。利用可能になり次第、自動的に戻ります。 [TLV_VIDEO_UNAVAILABLE]';
      playbackStateElement.textContent = '音声のみ再生中';
      appendLog('映像復旧不能のため音声のみへ移行しました [TLV_VIDEO_UNAVAILABLE]');
    } else if (event.mode === MsePlaybackMode.RESTORING_VIDEO) {
      statusElement.textContent =
        '映像を復旧しています。音声再生はそのまま継続します。 [TLV_VIDEO_UNAVAILABLE]';
      appendLog(`映像復旧候補を準備します RAP=${event.target.toFixed(6)}s`);
    } else if (event.mode === MsePlaybackMode.RECOVERING_VIDEO) {
      statusElement.textContent = '映像を復旧しています。音声は継続します。';
      appendLog(`映像復旧を開始しました RAP=${event.target.toFixed(6)}s`);
    } else {
      statusElement.textContent = '';
      if (event.reason === 'video-restored') {
        playbackStateElement.textContent = liveMode ? 'Live 再生中' : '再生中';
        appendLog(`映像復旧完了 frame=${event.mediaTime.toFixed(6)}s`);
      }
    }
  };

  let controller;
  controller = createMsePlaybackResilienceController({
    media,
    presentationStartUs,
    generation,
    initialMode,
    isActive,
    isCurrentLayer,
    switchInFlight,
    seek,
    onModeChange: renderMode,
    async onAudioOnlyRequested() {
      pipeline()?.setRequiredTracks(['audio']);
      playbackFlow.setRequiredTracks(['audio'], media.currentTime);
      const videoQueue = queues.get('video');
      const result = await setMseVideoTrackActive({
        mediaSource,
        active: false,
        videoSourceBuffer: videoQueue?.sourceBuffer ?? null,
      });
      if (!isActive()) return;
      if (result.changed) {
        appendLog('video SourceBuffer が activeSourceBuffers から外れたことを確認しました');
      } else if (!liveMode) {
        scheduleRecordedRebuild(MsePlaybackMode.AUDIO_ONLY, media.currentTime);
      } else if (videoQueue && mediaSource.readyState === 'open' &&
                 Array.from(mediaSource.sourceBuffers).includes(videoQueue.sourceBuffer)) {
        await videoQueue.quiesce();
        mediaSource.removeSourceBuffer(videoQueue.sourceBuffer);
        queues.delete('video');
        removeActiveVideoQueue(videoQueue);
        appendLog('Live 入力を中断せず video SourceBuffer を切り離し、音声を継続します');
      }
    },
    async onVideoRestoreRequested(event) {
      pipeline()?.setRequiredTracks(['video', 'audio']);
      playbackFlow.setRequiredTracks(['video', 'audio'], media.currentTime);
      const videoQueue = queues.get('video');
      const result = await setMseVideoTrackActive({
        mediaSource,
        active: true,
        videoSourceBuffer: videoQueue?.sourceBuffer ?? null,
      });
      if (!isActive()) return;
      if (result.changed) {
        appendLog('video SourceBuffer を再び active にし、実提示 frame を待ちます');
      } else if (!liveMode) {
        scheduleRecordedRebuild(MsePlaybackMode.AUDIO_VIDEO, event.target);
      } else {
        pipeline()?.setRequiredTracks(['audio']);
        playbackFlow.setRequiredTracks(['audio'], media.currentTime);
        controller.notifyVideoRestoreFailed(event.target, 'live-restore-requires-rebuild');
        appendLog('Live 映像候補をこの MediaSource で復旧できないため、音声を継続します');
      }
    },
    onVideoRestored() {
      pipeline()?.setRequiredTracks(['video', 'audio']);
      playbackFlow.setRequiredTracks(['video', 'audio'], media.currentTime);
    },
  });
  renderMode({mode: initialMode, reason: 'initial'});
  return controller;
}

export {MsePlaybackMode};
