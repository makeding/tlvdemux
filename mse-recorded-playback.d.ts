import type {MseAppendQueue} from './mse-append-queue';
import type {
  MseRecordedSeekResult,
  MseRecordedSource,
  MseSeekDemuxer,
} from './mse-playback';

export declare const MSE_RECORDED_SUPPLY_FAILED: 'MSE_RECORDED_SUPPLY_FAILED';
export type MseRecordedPlaybackState =
  | 'idle' | 'preparing' | 'locating-entry' | 'supplying' | 'draining'
  | 'finalizing' | 'ended' | 'seeking' | 'cancelled' | 'failed';
export declare const MSE_RECORDED_STATES: readonly MseRecordedPlaybackState[];

export interface MseRecordedPlaybackSnapshot {
  state: MseRecordedPlaybackState;
  reason: string | null;
  generation: number;
  offset: string;
  sourceSize: string;
  bytesRead: string;
  currentTime: number;
  commonAhead: number;
  requiredTracks: ('video' | 'audio')[];
  queues: Record<string, Record<string, unknown>>;
}

export declare class MseRecordedPlaybackError extends Error {
  readonly code: typeof MSE_RECORDED_SUPPLY_FAILED;
  readonly diagnostics: MseRecordedPlaybackSnapshot;
}

export interface MseRecordedPlaybackController {
  readonly state: MseRecordedPlaybackState;
  readonly generation: number;
  readonly offset: bigint;
  readonly bytesRead: bigint;
  readonly entry: MseRecordedSeekResult | null;
  readonly entryTimeSeconds: number;
  readonly requiredTracks: ('video' | 'audio')[];
  setRequiredTracks(
    requiredTracks: readonly ('video' | 'audio')[], entryTimeSeconds?: number,
  ): ('video' | 'audio')[];
  entryRange(): {start: number; end: number} | null;
  entryCovered(): boolean;
  commonAhead(): number;
  diagnostics(): {
    current: MseRecordedPlaybackSnapshot;
    history: Array<MseRecordedPlaybackSnapshot & {kind: string}>;
  };
  notifyUpdateEnd(): void;
  notifyBufferedChange(): void;
  notifyMediaTimeChange(): void;
  submitEvent(event: {type: string; [name: string]: unknown}): MseRecordedPlaybackSnapshot;
  start(targetTimeSeconds?: number): Promise<unknown>;
  seek(targetTimeSeconds: number): Promise<MseRecordedSeekResult | null>;
  cancel(): Promise<void>;
}

export declare function createMseRecordedPlaybackController(options: {
  source: MseRecordedSource;
  demuxer: MseSeekDemuxer & {
    flush?(): unknown | Promise<unknown>;
    finalizeIndex?(): unknown | Promise<unknown>;
    setMsePlaybackPosition?(presentationTimeUs: bigint): unknown | Promise<unknown>;
  };
  media: {currentTime: number};
  queues: Map<string, MseAppendQueue>;
  requiredTracks?: readonly ('video' | 'audio')[];
  initialOffset?: bigint;
  chunkBytes?: number;
  highSeconds?: number;
  lowSeconds?: number;
  diagnosticLimit?: number;
  progressPollMilliseconds?: number;
  locateEntry?: (context: {
    targetTimeSeconds: number;
    generation: number;
    source: MseRecordedSource;
    demuxer: MseSeekDemuxer;
    signal: AbortSignal;
  }) => Promise<MseRecordedSeekResult | null>;
  checkError?: () => void;
  finalize?: (context: {
    generation: number;
    offset: bigint;
    bytesRead: bigint;
  }) => unknown | Promise<unknown>;
  onStateChange?: (snapshot: MseRecordedPlaybackSnapshot & {previous: string}) => void;
  onProgress?: (snapshot: MseRecordedPlaybackSnapshot) => void;
  onDiagnostic?: (snapshot: MseRecordedPlaybackSnapshot & {kind: string}) => void;
}): MseRecordedPlaybackController;
