import type {MseAppendQueue, MseBufferedRange} from './mse-append-queue';

export declare const MSE_STARTUP_NO_COMMON_AV: 'MSE_STARTUP_NO_COMMON_AV';
export declare const MSE_SEEK_NO_COMMON_AV: 'MSE_SEEK_NO_COMMON_AV';
export declare const MSE_SEEK_READ_BUDGET_BYTES: 16777216;

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
  entryRange(): MseBufferedRange | null;
  entryCovered(): boolean;
  commonAhead(): number;
  afterPush(byteLength: number, isActive?: () => boolean): Promise<{
    commonAhead: number;
    entryCovered: boolean;
  }>;
}

export declare function commonBufferedRanges(queues: MsePlaybackQueues): MseBufferedRange[];
export declare function commonBufferedAhead(
  media: MseMediaClock, queues: MsePlaybackQueues, toleranceSeconds?: number,
): number;
export declare function createMsePlaybackFlowControl(
  options: MsePlaybackFlowControlOptions,
): MsePlaybackFlowControl;
export declare function startMsePlayback(options: {
  media: MseMediaClock & {play(): Promise<void>};
  queues: MsePlaybackQueues;
  liveMode?: boolean;
  minimumLiveBufferSeconds?: number;
  play?: () => Promise<void>;
}): {
  range: MseBufferedRange;
  commonAhead: number;
  aligned: boolean;
  playResult: Promise<void>;
} | null;
export declare function createMsePlaybackDamageRecovery(options: {
  media: MseMediaClock & {seeking: boolean; paused: boolean; play(): Promise<void>};
  presentationStartUs?: bigint;
  isActive?: () => boolean;
  isCurrentLayer?: (damage: Record<string, unknown>) => boolean;
  switchInFlight?: () => boolean;
  seek: (targetSeconds: number, previousTimeSeconds: number) => void;
}): {
  notifyWaiting(): {start: number; end: number} | null;
  reset(): void;
  reportDamage(damage: {
    action: string;
    recoveryTimeUs: bigint | null;
    [name: string]: unknown;
  }): {start: number; end: number} | null;
};

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
  flowControl?: MsePlaybackFlowControl;
  signal?: AbortSignal | null;
  isActive?: () => boolean;
  headReady: () => boolean;
  candidateVideoTrack?: (track: MseSeekTrack) => boolean;
  videoTrackPriority?: (track: MseSeekTrack) => number;
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
