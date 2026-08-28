import type {MseAppendQueue, MseBufferedRange} from './mse-append-queue';

export declare const MSE_STARTUP_NO_COMMON_AV: 'MSE_STARTUP_NO_COMMON_AV';
export declare const MSE_SEEK_NO_COMMON_AV: 'MSE_SEEK_NO_COMMON_AV';
export declare const TLV_VIDEO_UNAVAILABLE: 'TLV_VIDEO_UNAVAILABLE';
export declare const MSE_SEEK_READ_BUDGET_BYTES: 16777216;
export type MseRequiredTrack = 'video' | 'audio';
export type MsePlaybackModeValue =
  | 'audio-video' | 'recovering-video' | 'audio-only' | 'restoring-video';
export declare const MsePlaybackMode: Readonly<{
  AUDIO_VIDEO: 'audio-video';
  RECOVERING_VIDEO: 'recovering-video';
  AUDIO_ONLY: 'audio-only';
  RESTORING_VIDEO: 'restoring-video';
}>;

export declare class MseStartupBufferError extends Error {
  readonly code: typeof MSE_STARTUP_NO_COMMON_AV;
  constructor(message?: string);
}

export type MseRecordedSeekFailureReason =
  | 'budget-exhausted' | 'no-rap' | 'no-common-av' | 'source-ended' | 'demux-failed';

export declare class MseRecordedSeekError extends Error {
  readonly code: typeof MSE_SEEK_NO_COMMON_AV;
  readonly reason: MseRecordedSeekFailureReason;
  constructor(reason?: MseRecordedSeekFailureReason, message?: string | null);
}

export interface MseMediaClock { currentTime: number; }
export type MsePlaybackQueues = Map<string, Pick<
  MseAppendQueue,
  'bufferedRanges' | 'trimBefore' | 'waitFlowControlled' | 'waitStable'
>>;

export interface MsePlaybackFlowControlOptions {
  media: MseMediaClock;
  queues: MsePlaybackQueues;
  requiredTracks?: readonly MseRequiredTrack[];
  entryKind?: 'startup' | 'live' | 'seek';
  entryTimeSeconds?: number;
  entryToleranceSeconds?: number;
  highSeconds?: number;
  lowSeconds?: number;
  startupNoProgressBytes?: number;
  queueHighBytes?: number;
  backBufferSeconds?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface MsePlaybackFlowControl {
  readonly entryKind: 'startup' | 'live' | 'seek';
  readonly entryTimeSeconds: number;
  readonly requiredTracks: MseRequiredTrack[];
  setRequiredTracks(
    requiredTracks: readonly MseRequiredTrack[], entryTimeSeconds?: number,
  ): MseRequiredTrack[];
  entryRange(): MseBufferedRange | null;
  entryCovered(): boolean;
  commonAhead(): number;
  afterPush(byteLength: number, isActive?: () => boolean): Promise<{
    commonAhead: number;
    entryCovered: boolean;
  }>;
}

export declare function commonBufferedRanges(
  queues: MsePlaybackQueues, requiredTracks?: readonly MseRequiredTrack[],
): MseBufferedRange[];
export declare function commonBufferedAhead(
  media: MseMediaClock, queues: MsePlaybackQueues, toleranceSeconds?: number,
  requiredTracks?: readonly MseRequiredTrack[],
): number;
export declare function createMsePlaybackFlowControl(
  options: MsePlaybackFlowControlOptions,
): MsePlaybackFlowControl;
export declare function startMsePlayback(options: {
  media: MseMediaClock & {play(): Promise<void>};
  queues: MsePlaybackQueues;
  liveMode?: boolean;
  minimumLiveBufferSeconds?: number;
  requiredTracks?: readonly MseRequiredTrack[];
  play?: () => Promise<void>;
}): {
  range: MseBufferedRange;
  commonAhead: number;
  aligned: boolean;
  playResult: Promise<void>;
} | null;
export declare function createMsePlaybackDamageRecovery(options: {
  media: MseMediaClock & {
    seeking: boolean;
    paused: boolean;
    readonly videoFrameCallbackSupported?: boolean;
    play(): Promise<void>;
    buffered?: {length: number; start(index: number): number; end(index: number): number};
    requestVideoFrameCallback?: (callback: (
      now: number, metadata: {mediaTime: number; presentedFrames?: number},
    ) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  presentationStartUs?: bigint;
  observeFramesAutomatically?: boolean;
  isActive?: () => boolean;
  isCurrentLayer?: (damage: Record<string, unknown>) => boolean;
  switchInFlight?: () => boolean;
  isTargetBuffered?: (targetSeconds: number) => boolean;
  seek: (targetSeconds: number, previousTimeSeconds: number, detail: {
    action: 'seek-if-stalled' | 'seek';
    damage: Record<string, unknown>;
    firstRecoveryTime: number;
    lastPresentedTime: number | null;
    waitingTime: number;
  }) => void;
}): {
  notifyWaiting(): {start: number; end: number} | null;
  notifyBufferedChange(): {start: number; end: number} | null;
  observeAccessUnit(unit: {
    codec: string;
    trackId: bigint | number;
    randomAccess: boolean;
    ptsValue: bigint | number;
    ptsTimescale: number;
    [name: string]: unknown;
  }): {start: number; end: number} | null;
  /** Test/integration seam; normal browser use is observed automatically. */
  observePresentedFrame(mediaTimeSeconds: number): number | null;
  destroy(): void;
  reset(): void;
  reportDamage(damage: {
    action: 'none' | 'seek-if-stalled' | 'seek' | 'wait-for-recovery';
    videoTrackId: bigint | number;
    startTimeUs: bigint | number | null;
    recoveryTimeUs: bigint | null;
    startInputOffset: bigint | number;
    endInputOffset: bigint | number;
    recoveryInputOffset: bigint | number;
    recoveryRestartOffset: bigint | number;
    [name: string]: unknown;
  }): {start: number; end: number} | null;
};

export interface MsePlaybackModeChange {
  mode: MsePlaybackModeValue;
  previousMode?: MsePlaybackModeValue;
  generation: unknown;
  code: typeof TLV_VIDEO_UNAVAILABLE | null;
  reason?: string;
  target?: number;
  mediaTime?: number;
  attemptedRaps?: number[];
  unit?: Record<string, unknown>;
  damage?: Record<string, unknown>;
}

export interface MsePlaybackResilienceController {
  readonly mode: MsePlaybackModeValue;
  readonly generation: unknown;
  readonly attemptedRaps: number[];
  readonly videoFrameObservationSupported: boolean;
  reportDamage(damage: Record<string, unknown>): {start: number; end: number} | null;
  notifyWaiting(): {start: number; end: number} | MsePlaybackModeChange | null;
  notifyBufferedChange(): {start: number; end: number} | null;
  observeAccessUnit(unit: {
    codec: string;
    trackId: bigint | number;
    randomAccess: boolean;
    ptsValue: bigint | number;
    ptsTimescale: number;
    [name: string]: unknown;
  }): {start: number; end: number} | MsePlaybackModeChange | null;
  observePresentedFrame(mediaTimeSeconds: number): number | null;
  notifyVideoRestoreFailed(target?: number | null, reason?: string): MsePlaybackModeChange | null;
  notifyMediaElementChanged(): void;
  notifyExplicitSeek(nextGeneration?: unknown): MsePlaybackModeChange;
  notifyTrackSwitch(nextGeneration?: unknown): MsePlaybackModeChange;
  reset(nextGeneration?: unknown): MsePlaybackModeChange;
  notifySourceEnded(): MsePlaybackModeChange;
  destroy(): void;
}

export declare function createMsePlaybackResilienceController(options: {
  media: MseMediaClock & {
    seeking: boolean;
    paused: boolean;
    play(): Promise<void>;
    buffered?: {length: number; start(index: number): number; end(index: number): number};
    requestVideoFrameCallback?: (callback: (
      now: number, metadata: {mediaTime: number; presentedFrames?: number},
    ) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  presentationStartUs?: bigint;
  generation?: unknown;
  initialMode?: 'audio-video' | 'audio-only' | 'restoring-video';
  initialRestoreTarget?: number | null;
  maximumRecoveryAttempts?: number;
  isActive?: () => boolean;
  isCurrentLayer?: (damage: Record<string, unknown>) => boolean;
  switchInFlight?: () => boolean;
  isTargetBuffered?: (targetSeconds: number) => boolean;
  seek: (targetSeconds: number, previousTimeSeconds: number, detail: Record<string, unknown>) => void;
  onModeChange?: (event: MsePlaybackModeChange) => void;
  onAudioOnlyRequested?: (event: MsePlaybackModeChange) => unknown | Promise<unknown>;
  onVideoRestoreRequested?: (event: MsePlaybackModeChange) => unknown | Promise<unknown>;
  onVideoRestored?: (event: MsePlaybackModeChange) => void;
}): MsePlaybackResilienceController;

export interface MseRecordedSource {
  size: bigint;
  read(offset: bigint, length: bigint): Promise<Uint8Array>;
}
export interface MseSeekTrack {
  trackId: bigint | number;
  kind: string;
  codec?: string;
  [name: string]: unknown;
}
export interface MseSeekAccessUnit {
  trackId: bigint | number;
  codec: string;
  ptsValue: bigint;
  ptsTimescale: number;
  randomAccess: boolean;
  restartOffset: bigint;
  [name: string]: unknown;
}
export interface MseSeekDemuxer {
  push(data: Uint8Array): boolean | Promise<boolean>;
  reposition(offset: bigint, preserveIndex: boolean): unknown | Promise<unknown>;
  setMseOutputEnabled(enabled: boolean): unknown | Promise<unknown>;
  setIndexDuration(durationUs: bigint): boolean | Promise<boolean>;
  estimateOffset(targetUs: bigint, sourceSize: bigint): bigint | null | Promise<bigint | null>;
}
export interface MseRecordedSeekRap {
  trackId: bigint | number;
  ptsUs: bigint;
  seconds: number;
  restartOffset: bigint;
}
export interface MseRecordedSeekProgress {
  phase: string;
  bytesRead: bigint;
  budgetBytes: bigint;
  offset: bigint;
}
export interface MseRecordedSeekResult {
  targetUs: bigint;
  sourceTargetUs: bigint;
  estimateOffset: bigint;
  restartOffset: bigint;
  rapPresentationTimeUs: bigint;
  nextOffset: bigint;
  bytesRead: bigint;
  budgetBytes: bigint;
}
export interface MseRecordedSeekSessionOptions {
  targetTimeSeconds?: number;
  targetUs?: bigint;
  presentationStartUs?: bigint;
  presentationEndUs?: bigint;
  source: MseRecordedSource;
  durationUs: bigint;
  demuxer: MseSeekDemuxer;
  media: MseMediaClock;
  queues: MsePlaybackQueues;
  requiredTracks?: readonly MseRequiredTrack[];
  flowControl?: MsePlaybackFlowControl;
  signal?: AbortSignal | null;
  isActive?: () => boolean;
  headReady: () => boolean;
  candidateTrack?: (track: MseSeekTrack) => boolean;
  candidateVideoTrack?: (track: MseSeekTrack) => boolean;
  trackPriority?: (track: MseSeekTrack) => number;
  videoTrackPriority?: (track: MseSeekTrack) => number;
  activateTrack?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  activateVideoTrack?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  beforeLanding?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  waitForAppends?: () => Promise<void>;
  checkError?: () => void;
  chunkBytes?: number;
  readBudgetBytes?: number;
  probePrerollSeconds?: number;
  onProgress?: (progress: MseRecordedSeekProgress) => void;
}
export interface MseRecordedSeekSession {
  run(): Promise<MseRecordedSeekResult>;
  observeTrack(track: MseSeekTrack): void;
  observeTrackRemoved(track: MseSeekTrack): void;
  observeAccessUnit(unit: MseSeekAccessUnit): void;
  readonly phase: string;
  readonly bytesRead: bigint;
  readonly budgetBytes: bigint;
}
export declare function createMseRecordedSeekSession(
  options: MseRecordedSeekSessionOptions,
): MseRecordedSeekSession;
