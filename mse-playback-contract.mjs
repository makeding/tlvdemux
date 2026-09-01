export const MSE_STARTUP_NO_COMMON_AV = 'MSE_STARTUP_NO_COMMON_AV';
export const MSE_SEEK_NO_COMMON_AV = 'MSE_SEEK_NO_COMMON_AV';
export const TLV_VIDEO_UNAVAILABLE = 'TLV_VIDEO_UNAVAILABLE';
export const MSE_SEEK_READ_BUDGET_BYTES = 16 * 1024 * 1024;
export const MSE_SEEK_MAX_READ_BUDGET_BYTES = 64 * 1024 * 1024;

export const MsePlaybackMode = Object.freeze({
  AUDIO_VIDEO: 'audio-video',
  RECOVERING_VIDEO: 'recovering-video',
  AUDIO_ONLY: 'audio-only',
  RESTORING_VIDEO: 'restoring-video',
});

export class MseStartupBufferError extends Error {
  constructor(message =
    'Audio and video could not be aligned with timestamp 0. Check the input and retry playback.') {
    super(`${MSE_STARTUP_NO_COMMON_AV}: ${message}`);
    this.name = 'MseStartupBufferError';
    this.code = MSE_STARTUP_NO_COMMON_AV;
  }
}

export class MseRecordedSeekError extends Error {
  constructor(reason = 'no-common-av', message = null) {
    const detail = message ?? ({
      'budget-exhausted':
        'The requested time did not form a common audio/video buffer within its bounded seek budget.',
      'no-rap': 'No random access point at or before the requested time was found within the seek budget.',
      'no-common-av': 'Audio and video could not form a common buffer at the requested time.',
      'source-ended': 'The input ended before audio and video covered the requested time.',
      'demux-failed': 'The demuxer could not prepare the requested time.',
    }[reason] ?? 'The requested time could not be prepared.');
    super(`${MSE_SEEK_NO_COMMON_AV}: ${detail} Input reads have stopped; retry the seek or choose a nearby time.`);
    this.name = 'MseRecordedSeekError';
    this.code = MSE_SEEK_NO_COMMON_AV;
    this.reason = reason;
  }
}
