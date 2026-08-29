import type {
  FinalizeMseMediaSourceOptions,
  MseAppendQueue,
  MseAppendQueueOptions,
} from './mse-append-queue';

export declare const MSE_OUTPUT_PENDING_LIMIT_BYTES: 4194304;

export interface MseOutputInit {
  type: 'video' | 'audio';
  mime: string;
  data: Uint8Array;
  [name: string]: unknown;
}
export interface MseOutputSegment {
  type: 'video' | 'audio';
  data: Uint8Array;
  startTimeUs: bigint;
  endTimeUs: bigint;
  [name: string]: unknown;
}
export interface MseOutputSplice {
  presentationTimeUs: bigint;
  /** Complete SourceBuffer.timestampOffset in microseconds, not a delta. */
  timestampOffsetUs?: bigint;
  [name: string]: unknown;
}
export interface MseOutputSpliceResult {
  type: 'video' | 'audio';
  sourceBoundarySeconds: number;
  outputBoundarySeconds: number;
  timestampOffsetSeconds: number;
  detail: MseOutputSplice;
}
export interface MseOutputPipelineOptions {
  mediaSource: MediaSource;
  media: HTMLMediaElement;
  queues?: Map<string, MseAppendQueue>;
  queueFactory?: (
    type: string,
    init: MseOutputInit,
    onUpdateEnd: (() => void) | null,
    options: MseAppendQueueOptions,
  ) => MseAppendQueue;
  onUpdateEnd?: (() => void) | null;
  onQueueCreated?: (type: string, queue: MseAppendQueue) => void;
  onInitObserved?: (init: MseOutputInit) => void;
  onInitInstalled?: (init: MseOutputInit, queue: MseAppendQueue, reconfigured: boolean) => void;
  onFirstSegment?: (type: string, segment: MseOutputSegment) => void;
  onSplice?: (splice: MseOutputSpliceResult) => void;
  queueOptions?: MseAppendQueueOptions;
  freshRecordedEntryAlignment?: boolean;
  recordedPresentationStartUs?: bigint | null;
  pendingBytesLimit?: number;
  mode?: 'audio-video' | 'audio-only';
  requiredTracks?: readonly ('video' | 'audio')[];
  onInactiveOutput?: (event: {
    kind: 'init' | 'segment' | 'splice';
    type: 'video' | 'audio';
    byteLength: number;
  }) => void;
}
export interface MseOutputPipeline {
  readonly queues: Map<string, MseAppendQueue>;
  readonly mode: 'audio-video' | 'audio-only';
  readonly requiredTracks: ('video' | 'audio')[];
  setRequiredTracks(requiredTracks: readonly ('video' | 'audio')[]): ('video' | 'audio')[];
  onMseInit(init: MseOutputInit): void;
  onMseSegment(segment: MseOutputSegment): void;
  onMseVideoSplice(splice: MseOutputSplice): void;
  onMseAudioSplice(splice: MseOutputSplice): void;
  clearPendingMedia(type?: 'video' | 'audio' | null): void;
  waitStable(): Promise<void>;
  finalize(options?: FinalizeMseMediaSourceOptions): Promise<{truncatedTo: number | null}>;
  pendingState(): {
    initTypes: string[];
    spliceTypes: string[];
    segmentBytes: Record<string, number>;
    requiredTracks: ('video' | 'audio')[];
    discardedBytes: number;
  };
}
export declare function createMseOutputPipeline(
  options: MseOutputPipelineOptions,
): MseOutputPipeline;

export declare function setMseVideoTrackActive(options: {
  mediaSource: MediaSource;
  active: boolean;
  videoSourceBuffer?: SourceBuffer | null;
  settle?: () => Promise<void>;
}): Promise<{
  supported: boolean;
  changed: boolean;
  active: boolean;
  requiresRebuild: boolean;
  sourceBuffer?: SourceBuffer;
}>;
