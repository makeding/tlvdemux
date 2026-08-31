import type {MseAppendQueue, MseBufferedRange} from './mse-append-queue';

export declare const ENTRY_TOLERANCE_SECONDS: number;
export declare const MSE_PLAYBACK_ENTRY_READ_BUDGET_BYTES: number;
export declare const MSE_STARTUP_NO_COMMON_AV: 'MSE_STARTUP_NO_COMMON_AV';
export declare const TLV_VIDEO_UNAVAILABLE: 'TLV_VIDEO_UNAVAILABLE';
export declare const MsePlaybackMode: {
  readonly AUDIO_VIDEO: 'audio-video';
  readonly RECOVERING_VIDEO: 'recovering-video';
  readonly AUDIO_ONLY: 'audio-only';
  readonly RESTORING_VIDEO: 'restoring-video';
};
export type MsePlaybackModeValue = typeof MsePlaybackMode[keyof typeof MsePlaybackMode];

export declare class MseStartupBufferError extends Error {
  readonly code: typeof MSE_STARTUP_NO_COMMON_AV;
}

export declare function commonBufferedRanges(
  queues: Map<string, MseAppendQueue>, requiredTracks?: string[],
): MseBufferedRange[];
export declare function commonCommittedRanges(
  queues: Map<string, MseAppendQueue>, requiredTracks?: string[],
): MseBufferedRange[];
export declare function commonBufferedAhead(
  media: {currentTime: number}, queues: Map<string, MseAppendQueue>,
  toleranceSeconds?: number, requiredTracks?: string[],
): number;
export declare function startMsePlayback(options: {
  media: HTMLMediaElement;
  queues: Map<string, MseAppendQueue>;
  liveMode?: boolean;
  minimumLiveBufferSeconds?: number;
  requiredTracks?: string[];
  play?: () => unknown;
}): {range: MseBufferedRange; commonAhead: number; aligned: boolean; playResult: unknown} | null;

export interface MsePlaybackFlowControl {
  readonly entryKind: 'startup' | 'live';
  readonly entryTimeSeconds: number;
  readonly requiredTracks: string[];
  setRequiredTracks(tracks: string[], entryTimeSeconds?: number): string[];
  entryRange(): MseBufferedRange | null;
  entryCovered(): boolean;
  commonAhead(): number;
  afterPush(byteLength: number, isActive?: () => boolean): Promise<{
    commonAhead: number; entryCovered: boolean;
  }>;
}
export declare function createMsePlaybackFlowControl(options: {
  media: {currentTime: number};
  queues: Map<string, MseAppendQueue>;
  requiredTracks?: string[];
  entryKind?: 'startup' | 'live';
  entryTimeSeconds?: number;
  entryToleranceSeconds?: number;
  highSeconds?: number;
  lowSeconds?: number;
  startupNoProgressBytes?: number;
  queueHighBytes?: number;
  backBufferSeconds?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): MsePlaybackFlowControl;
