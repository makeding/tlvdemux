import type {MseAppendQueue} from './mse-append-queue';
import type {RecordedSource} from './recorded-source';

export declare const MSE_RECORDED_READ_BUDGET_BYTES: 16777216;
export declare const MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND: 'MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND';
export declare const MSE_RECORDED_VIDEO_NOT_FOUND: 'MSE_RECORDED_VIDEO_NOT_FOUND';
export declare const MSE_RECORDED_ATOMIC_COMMIT_FAILED: 'MSE_RECORDED_ATOMIC_COMMIT_FAILED';
export declare const MSE_RECORDED_SOURCE_FAILED: 'MSE_RECORDED_SOURCE_FAILED';
export type MseRecordedPlaybackState =
  | 'idle' | 'locating-audio' | 'resolving-video' | 'committing'
  | 'running' | 'ended' | 'error';
export type MseRecordedVideoMode = 'preferred' | 'rainfall' | 'frozen';

export interface MseRecordedAudioWindow {
  startTimeSeconds: number;
  endTimeSeconds: number;
  inputOffset?: bigint;
}
export interface MseRecordedVideoWindow {
  trackId?: bigint;
  startTimeSeconds: number;
  endTimeSeconds: number;
  restartOffset?: bigint;
  closed?: boolean;
  [name: string]: unknown;
}
export declare function resolveRecordedVideoWindow(options: {
  audio: MseRecordedAudioWindow;
  preferred?: MseRecordedVideoWindow[];
  rainfall?: MseRecordedVideoWindow[];
  frozen?: MseRecordedVideoWindow[];
}): {mode: MseRecordedVideoMode; video: MseRecordedVideoWindow; audio: MseRecordedAudioWindow} | null;

export declare class MseRecordedPlaybackError extends Error {
  readonly code: string;
  readonly diagnostics: Record<string, unknown>;
}

export declare function createMseRecordedWindowLocator(options: {
  source: RecordedSource;
  demuxer: Record<string, (...args: any[]) => any>;
  queues: Map<string, Pick<MseAppendQueue, 'waitStable' | 'waitIdle' | 'committedRanges'>>;
  presentationStartUs?: bigint;
  presentationEndUs?: bigint | null;
  selectedAudioTrack: () => bigint | {trackId: bigint} | null;
  preferredVideoTrack: () => bigint | {trackId: bigint} | null;
  rainfallVideoTrack?: () => bigint | {trackId: bigint} | null;
  activateVideoTrack?: (mode: MseRecordedVideoMode, video: MseRecordedVideoWindow) => unknown;
  onProgress?: (progress: {bytesRead: bigint; budgetBytes: bigint; offset: bigint}) => void;
  chunkBytes?: number;
  audioWindowSeconds?: number;
}): {
  locate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeAccessUnit(unit: Record<string, unknown>): void;
};

export interface MseRecordedPlaybackController {
  readonly state: MseRecordedPlaybackState;
  readonly videoMode: MseRecordedVideoMode;
  readonly nextOffset: bigint;
  readonly bytesRead: bigint;
  watermarks(): {highMediaSeconds: number; lowMediaSeconds: number};
  diagnostics(): Record<string, unknown>;
  setPlaybackRate(rate: number): {highMediaSeconds: number; lowMediaSeconds: number};
  notifyPresentedFrame(mediaTimeSeconds: number): void;
  notifyConsumption(): void;
  reportSourceDamage(): void;
  notifyPreferredStableRap(): void;
  reportPlaybackQuality(options: {
    totalFrames: number;
    droppedFrames: number;
    durationSeconds?: number;
    mediaError?: unknown;
  }): MseRecordedVideoMode;
  start(targetTimeSeconds?: number): Promise<void>;
  seek(targetTimeSeconds: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

export declare function createMseRecordedPlaybackController(options: {
  source: RecordedSource;
  demuxer: {push(data: Uint8Array): boolean | void | Promise<boolean | void>};
  media: {currentTime: number; playbackRate: number};
  queues: Map<string, Pick<MseAppendQueue,
    'waitStable' | 'waitIdle' | 'bufferedRanges' | 'committedRanges' | 'trimBefore' |
    'canRetryQuotaAfterRemove' | 'retryQuotaAfterRemove'>>;
  initialOffset?: bigint;
  highWallSeconds?: number;
  lowWallSeconds?: number;
  quotaStartWallSeconds?: number;
  readBudgetBytes?: number;
  commonAhead?: () => number;
  locateSeekWindow: (options: {
    targetTimeSeconds: number;
    readBudgetBytes: bigint;
    signal: AbortSignal;
    transition: (state: MseRecordedPlaybackState) => void;
    waitForQueues: () => Promise<void>;
  }) => Promise<{nextOffset: bigint; bytesRead: bigint; videoMode: MseRecordedVideoMode}>;
  switchVideoMode?: (mode: MseRecordedVideoMode, reason: string | null) => unknown;
  play?: () => unknown;
  onPlaybackStart?: (event: {
    quotaLimited: boolean;
    playResult: unknown;
    diagnostics: Record<string, unknown>;
  }) => void;
  onStateChange?: (diagnostics: Record<string, unknown>) => void;
  onProgress?: (diagnostics: Record<string, unknown>) => void;
}): MseRecordedPlaybackController;
