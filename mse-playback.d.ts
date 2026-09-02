import type {MseAppendQueue, MseBufferedRange} from './mse-append-queue';

export declare const MSE_STARTUP_NO_COMMON_AV: 'MSE_STARTUP_NO_COMMON_AV';
export declare const MSE_SEEK_NO_COMMON_AV: 'MSE_SEEK_NO_COMMON_AV';
export declare const TLV_VIDEO_UNAVAILABLE: 'TLV_VIDEO_UNAVAILABLE';
export declare const MSE_SEEK_READ_BUDGET_BYTES: 16777216;
export declare const MSE_SEEK_MAX_READ_BUDGET_BYTES: 67108864;
export type MseRequiredTrack = 'video' | 'audio';
export type MsePlaybackModeValue =
  | 'starting' | 'av' | 'switching' | 'held-audio' | 'stalled' | 'restoring';
export declare const MsePlaybackMode: Readonly<{
  STARTING: 'starting';
  AV: 'av';
  SWITCHING: 'switching';
  HELD_AUDIO: 'held-audio';
  STALLED: 'stalled';
  RESTORING: 'restoring';
}>;

export declare class MseStartupBufferError extends Error {
  readonly code: typeof MSE_STARTUP_NO_COMMON_AV;
}
export declare class MseRecordedSeekError extends Error {
  readonly code: typeof MSE_SEEK_NO_COMMON_AV;
  readonly reason: string;
}

export interface MsePlaybackQueues extends Map<string, Pick<
  MseAppendQueue,
  'bufferedRanges' | 'committedRanges' | 'trimBefore' | 'waitFlowControlled' | 'waitStable'
>> {}
export declare function commonBufferedRanges(
  queues: MsePlaybackQueues, requiredTracks?: readonly MseRequiredTrack[],
): MseBufferedRange[];
export declare function commonBufferedAhead(
  media: {currentTime: number}, queues: MsePlaybackQueues,
  toleranceSeconds?: number, requiredTracks?: readonly MseRequiredTrack[],
): number;
export declare function startMsePlayback(options: {
  media: {currentTime: number; play(): Promise<void>};
  queues: MsePlaybackQueues;
  liveMode?: boolean;
  minimumLiveBufferSeconds?: number;
  requiredTracks?: readonly MseRequiredTrack[];
}): {range: MseBufferedRange; commonAhead: number; aligned: boolean;
  playResult: Promise<void>} | null;

export interface MsePlaybackFlowControl {
  readonly entryKind: 'startup' | 'live' | 'seek';
  readonly entryTimeSeconds: number;
  readonly requiredTracks: MseRequiredTrack[];
  setRequiredTracks(tracks: readonly MseRequiredTrack[], entryTimeSeconds?: number):
    MseRequiredTrack[];
  entryRange(): MseBufferedRange | null;
  landingMode(): 'exact' | 'natural-start' | null;
  heldFrameEntryRange(): MseBufferedRange | null;
  entryCovered(): boolean;
  commonAhead(): number;
  afterPush(byteLength: number, isActive?: () => boolean): Promise<{
    commonAhead: number; entryCovered: boolean;
  }>;
}
export declare function createMsePlaybackFlowControl(options: {
  media: {currentTime: number};
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
}): MsePlaybackFlowControl;

export interface MseRecordedSource {
  size: bigint;
  read(offset: bigint, length: bigint): Promise<Uint8Array>;
}
export interface MseSeekDemuxer {
  push(data: Uint8Array): boolean | Promise<boolean>;
  reposition(offset: bigint, preserveIndex: boolean): unknown | Promise<unknown>;
  beginMseRecordedSeek(): unknown | Promise<unknown>;
  prepareMseRecordedSeekLanding(sourceBoundaryUs: bigint): unknown | Promise<unknown>;
  finishMseRecordedSeek(playbackPositionUs: bigint): unknown | Promise<unknown>;
  cancelMseRecordedSeek(): unknown | Promise<unknown>;
  [name: string]: unknown;
}
export interface MseRecordedSeekResult {
  requestedTimeSeconds: number;
  nextOffset: bigint;
  bytesRead: bigint;
  [name: string]: unknown;
}
export declare function createMseRecordedSeekSession(options: Record<string, unknown>): unknown;
