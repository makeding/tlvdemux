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
  forceReinitialize?: (type: string, init: MseOutputInit) => boolean;
  queueOptions?: MseAppendQueueOptions;
  pendingBytesLimit?: number;
}
export interface MseOutputPipeline {
  readonly queues: Map<string, MseAppendQueue>;
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
  };
}
export declare function createMseOutputPipeline(
  options: MseOutputPipelineOptions,
): MseOutputPipeline;
