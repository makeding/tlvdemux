import type {MseAppendQueue, MseBufferedRange} from './mse-append-queue';

export declare const MSE_STARTUP_NO_COMMON_AV: 'MSE_STARTUP_NO_COMMON_AV';
export declare const MSE_SEEK_NO_COMMON_AV: 'MSE_SEEK_NO_COMMON_AV';
export declare const TLV_VIDEO_UNAVAILABLE: 'TLV_VIDEO_UNAVAILABLE';
export declare const MSE_SEEK_READ_BUDGET_BYTES: 16777216;
export declare const MSE_SEEK_MAX_READ_BUDGET_BYTES: 67108864;
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
  'bufferedRanges' | 'committedRanges' | 'trimBefore' | 'waitFlowControlled' | 'waitStable'
>>;

export interface MsePlaybackFlowControlOptions {
  media: MseMediaClock;
  queues: MsePlaybackQueues;
  requiredTracks?: readonly MseRequiredTrack[];
  entryKind?: 'startup' | 'live' | 'seek';
  entryTimeSeconds?: number;
  entryToleranceSeconds?: number;
  browserBoundaryToleranceSeconds?: number;
  allowNaturalStart?: boolean;
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
  landingMode(): 'exact' | 'natural-start' | null;
  heldFrameEntryRange(): MseBufferedRange | null;
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
export declare function commonCommittedRanges(
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
  observeVideoRecoveryEvent(event: {
    videoTrackId: bigint | number;
    presentationTimeUs: bigint | number;
    phase: 'observation-started' | 'candidate-rejected' | 'stable-rap-committed';
  }): {start: number; end: number} | null;
  /** Test/integration seam; normal browser use is observed automatically. */
  observePresentedFrame(mediaTimeSeconds: number): number | null;
  notifyPlaybackPaused(): void;
  notifyPlaybackResumed(): void;
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

interface MsePlaybackModeChangeBase {
  previousMode?: MsePlaybackModeValue;
  generation: unknown;
  reason?: string;
  mediaTime?: number;
  attemptedRaps?: number[];
  unit?: Record<string, unknown>;
  damage?: Record<string, unknown>;
}
export type MsePlaybackModeChange = MsePlaybackModeChangeBase & (
  | {mode: 'audio-video'; code: null; target?: number}
  | {mode: 'audio-only'; code: typeof TLV_VIDEO_UNAVAILABLE; target?: number}
  | {mode: 'recovering-video'; code: null; target: number}
  | {mode: 'restoring-video'; code: typeof TLV_VIDEO_UNAVAILABLE; target: number}
);

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
  observeVideoRecoveryEvent(event: {
    videoTrackId: bigint | number;
    presentationTimeUs: bigint | number;
    phase: 'observation-started' | 'candidate-rejected' | 'stable-rap-committed';
  }): {start: number; end: number} | null;
  observePresentedFrame(mediaTimeSeconds: number): number | null;
  notifyPlaybackPaused(): void;
  notifyPlaybackResumed(): void;
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
  setMseRecordedSeekConcealmentTarget(presentationTimeUs: bigint | null): unknown | Promise<unknown>;
  getMseRecordedSeekLandingEvidence?(): MseRecordedSeekLandingEvidence | null |
    Promise<MseRecordedSeekLandingEvidence | null>;
  beginMseRecordedSeek(): unknown | Promise<unknown>;
  flushMseRecordedSeekAudio(): unknown | Promise<unknown>;
  flushMseRecordedSeekLanding(): unknown | Promise<unknown>;
  finishMseRecordedSeek(playbackPositionUs: bigint): unknown | Promise<unknown>;
  cancelMseRecordedSeek(): unknown | Promise<unknown>;
  setIndexDuration(durationUs: bigint): boolean | Promise<boolean>;
  previousSync?(targetUs: bigint): MseSeekPoint | null | Promise<MseSeekPoint | null>;
  estimateOffset(targetUs: bigint, sourceSize: bigint): bigint | null | Promise<bigint | null>;
}
export interface MseSeekPoint {
  presentationTimeUs: bigint;
  signallingOffset: bigint;
  randomAccessOffset: bigint;
  videoTrackId: bigint | number;
}
export interface MseRecordedSeekLandingEvidence {
  landingMode: 'exact' | 'held-frame';
  heldFrameTimeUs?: bigint | null;
  recoveryTimeUs?: bigint | null;
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
export interface MseRecordedSeekBudgetAuthorization {
  extended: boolean;
  saturated: boolean;
  baseBudgetBytes: bigint;
  maximumBudgetBytes: bigint;
  requiredBudgetBytes: bigint;
  authorizationThresholdBytes: bigint;
  authorizedBudgetBytes?: bigint;
  provedEndOffset: bigint;
}
export interface MseRecordedSeekResult {
  targetUs: bigint;
  requestedTimeSeconds: number;
  sourceTargetUs: bigint;
  estimateOffset: bigint;
  restartOffset: bigint;
  rapPresentationTimeUs: bigint;
  nextOffset: bigint;
  bytesRead: bigint;
  budgetBytes: bigint;
  baseBudgetBytes: bigint;
  maximumBudgetBytes: bigint;
  budgetAuthorization: MseRecordedSeekBudgetAuthorization;
  landingMode: 'exact' | 'natural-start' | 'held-frame';
  landingEvidence: MseRecordedSeekLandingEvidence | null;
  heldFrameTimeSeconds: number | null;
  recoveryTimeSeconds: number | null;
  heldFrameRange: MseBufferedRange | null;
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
  initialTracks?: readonly MseSeekTrack[];
  timelineEstablished?: boolean;
  candidateTrack?: (track: MseSeekTrack) => boolean;
  candidateVideoTrack?: (track: MseSeekTrack) => boolean;
  trackPriority?: (track: MseSeekTrack) => number;
  videoTrackPriority?: (track: MseSeekTrack) => number;
  activateTrack?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  activateVideoTrack?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  beforeLanding?: (track: MseSeekTrack, rap: MseRecordedSeekRap) => unknown | Promise<unknown>;
  estimateOffset?: ((targetUs: bigint, sourceSize: bigint) =>
    bigint | null | Promise<bigint | null>) | null;
  waitForAppends?: () => Promise<void>;
  checkError?: () => void;
  chunkBytes?: number;
  readBudgetBytes?: number;
  maxReadBudgetBytes?: number;
  landingReserveBytes?: number;
  onProgress?: (progress: MseRecordedSeekProgress) => void;
}
export interface MseRecordedSeekSession {
  run(): Promise<MseRecordedSeekResult>;
  observeTrack(track: MseSeekTrack): void;
  observeTrackRemoved(track: MseSeekTrack): void;
  observeAccessUnit(unit: MseSeekAccessUnit): void;
  observeDamage(damage: Record<string, unknown>): void;
  readonly phase: string;
  readonly bytesRead: bigint;
  readonly budgetBytes: bigint;
  readonly baseBudgetBytes: bigint;
  readonly maximumBudgetBytes: bigint;
}
export declare function createMseRecordedSeekSession(
  options: MseRecordedSeekSessionOptions,
): MseRecordedSeekSession;
