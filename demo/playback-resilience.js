import {
  MsePlaybackMode,
  createMsePlaybackResilienceController,
} from '../mse-playback.mjs?v=recorded-seek-concealment-v1';
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
  initialRestoreTarget = null,
  liveMode,
  isActive,
  isCurrentLayer,
  switchInFlight,
  seek,
  statusElement,
  playbackStateElement,
  appendLog,
  submitRecordedRecoveryEvent,
  requestLiveTransition,
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
      pipeline()?.setRequiredTracks(['video', 'audio']);
      playbackFlow().setRequiredTracks(['video', 'audio'], media.currentTime);
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
    initialRestoreTarget,
    isActive,
    isCurrentLayer,
    switchInFlight,
    seek,
    onModeChange: renderMode,
    async onAudioOnlyRequested() {
      pipeline()?.setRequiredTracks(['audio']);
      playbackFlow().setRequiredTracks(['audio'], media.currentTime);
      const currentQueues = queues();
      const videoQueue = currentQueues.get('video');
      const result = await setMseVideoTrackActive({
        mediaSource: mediaSource(),
        active: false,
        videoSourceBuffer: videoQueue?.sourceBuffer ?? null,
      });
      if (!isActive()) return;
      if (controller.mode !== MsePlaybackMode.AUDIO_ONLY) {
        if (result.changed) {
          await setMseVideoTrackActive({
            mediaSource: mediaSource(),
            active: true,
            videoSourceBuffer: videoQueue?.sourceBuffer ?? null,
          });
        }
        return;
      }
      if (result.changed) {
        appendLog('video SourceBuffer が activeSourceBuffers から外れたことを確認しました');
      } else if (!liveMode) {
        submitRecordedRecoveryEvent(MsePlaybackMode.AUDIO_ONLY, media.currentTime);
      } else if (currentQueues.has('audio') && !currentQueues.has('video')) {
        appendLog('失敗した映像候補を破棄し、現在の Live 音声を継続します');
      } else {
        try {
          await requestLiveTransition(MsePlaybackMode.AUDIO_ONLY, media.currentTime);
        } catch (error) {
          // A future RAP may supersede the audio-only candidate while it is
          // opening. Never tear video out of the active restoring candidate.
          if (controller.mode !== MsePlaybackMode.AUDIO_ONLY) return;
          const activeSource = mediaSource();
          if (videoQueue && activeSource.readyState === 'open' &&
              Array.from(activeSource.sourceBuffers).includes(videoQueue.sourceBuffer)) {
            await videoQueue.quiesce();
            activeSource.removeSourceBuffer(videoQueue.sourceBuffer);
            currentQueues.delete('video');
            appendLog('Live 純音声候補の準備に失敗したため video SourceBuffer を切り離し、音声を継続します');
          } else {
            throw error;
          }
        }
      }
    },
    async onVideoRestoreRequested(event) {
      pipeline()?.setRequiredTracks(['video', 'audio']);
      playbackFlow().setRequiredTracks(['video', 'audio'], media.currentTime);
      const videoQueue = queues().get('video');
      const result = await setMseVideoTrackActive({
        mediaSource: mediaSource(),
        active: true,
        videoSourceBuffer: videoQueue?.sourceBuffer ?? null,
      });
      if (!isActive() || controller.mode !== MsePlaybackMode.RESTORING_VIDEO) return;
      if (result.changed) {
        appendLog('video SourceBuffer を再び active にし、実提示 frame を待ちます');
      } else if (!liveMode) {
        submitRecordedRecoveryEvent(MsePlaybackMode.RESTORING_VIDEO, event.target);
      } else {
        const restored = await requestLiveTransition(
          MsePlaybackMode.RESTORING_VIDEO, event.target,
        );
        controller.observePresentedFrame(restored.presentedTime);
      }
    },
    onVideoRestored() {
      pipeline()?.setRequiredTracks(['video', 'audio']);
      playbackFlow().setRequiredTracks(['video', 'audio'], media.currentTime);
    },
  });
  return controller;
}

export {MsePlaybackMode};
