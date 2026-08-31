export const MSE_STARTUP_NO_COMMON_AV = 'MSE_STARTUP_NO_COMMON_AV';
export const TLV_VIDEO_UNAVAILABLE = 'TLV_VIDEO_UNAVAILABLE';
export const MSE_PLAYBACK_ENTRY_READ_BUDGET_BYTES = 16 * 1024 * 1024;

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
