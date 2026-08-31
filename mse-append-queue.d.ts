export interface MseAppendQueueOptions {
  retryDelayMilliseconds?: number;
  backBufferSeconds?: number;
  trimGranularitySeconds?: number;
  maximumAppendBatchBytes?: number;
  getBackBufferReferenceTime?: (media: HTMLMediaElement) => number | null;
  getMediaError?: (media: HTMLMediaElement) => string;
  destroyOnSourceClose?: boolean;
}

export interface MseBufferedRange {
  start: number;
  end: number;
}

export interface MseAppendTiming {
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

export interface FinalizeMseMediaSourceOptions {
  truncateToCommonEnd?: boolean;
  minimumTruncationSeconds?: number;
}

export declare class MseAppendQueue {
  readonly mediaElement: HTMLMediaElement;
  readonly mediaSource: MediaSource;
  readonly mime: string;
  readonly sourceBuffer: SourceBuffer;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  currentBytes: number;
  readonly currentOperation: unknown | null;
  updateEndCount: number;
  quotaExceededCount: number;
  lastAppendStartedAtMilliseconds: number | null;
  lastUpdateEndAtMilliseconds: number | null;
  lastQuotaExceededAtMilliseconds: number | null;
  readonly committedMediaRanges: MseBufferedRange[];
  readonly waiters: unknown[];
  error: Error | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  trimBeforeTime: number | null;
  forceTrim: boolean;
  quotaBlocked: boolean;
  quotaRetryAfterBatchReduction: boolean;
  state: 'running' | 'quiescing' | 'idle' | 'destroyed';
  onUpdateEnd: (() => void) | null;
  scheduledTimestampOffsetSeconds: number;
  maximumAppendBatchBytes: number;
  currentAppendBatchBytes: number;
  getBackBufferReferenceTime: (media: HTMLMediaElement) => number | null;
  destroyOnSourceClose: boolean;

  constructor(
    mediaSource: MediaSource,
    mediaElement: HTMLMediaElement,
    mime: string,
    onUpdateEnd?: (() => void) | null,
    options?: MseAppendQueueOptions,
  );

  append(data: Uint8Array, timing?: MseAppendTiming): void;
  appendInitialization(data: Uint8Array, mime: string, forceChangeType?: boolean): void;
  setTimestampOffset(offsetSeconds: number): void;
  spliceFrom(time: number, offsetSeconds: number): void;
  replaceFrom(time: number): void;
  removeRange(start: number, end: number): void;
  pump(): void;
  bufferedAhead(): number;
  bufferedRanges(): MseBufferedRange[];
  committedRanges(): MseBufferedRange[];
  diagnostics(nowMilliseconds?: number): {
    state: 'running' | 'quiescing' | 'idle' | 'destroyed';
    queuedBytes: number;
    currentBytes: number;
    pendingOperations: number;
    updating: boolean;
    currentOperation: string | null;
    updateEndCount: number;
    quotaExceededCount: number;
    quotaBlocked: boolean;
    appendBatchLimitBytes: number;
    backBufferReferenceTime: number | null;
    pendingTrimBeforeTime: number | null;
    retryScheduled: boolean;
    millisecondsSinceAppendStarted: number | null;
    millisecondsSinceUpdateEnd: number | null;
    millisecondsSinceQuotaExceeded: number | null;
  };
  notifyDemand(): boolean;
  trimBackBuffer(force?: boolean): void;
  trimBefore(time: number, force?: boolean): void;
  waitBelow(limit: number): Promise<void>;
  isStable(): boolean;
  waitStable(): Promise<void>;
  isFlowControlled(limit: number): boolean;
  waitFlowControlled(limit: number): Promise<void>;
  isIdle(): boolean;
  waitIdle(): Promise<void>;
  quiesce(): Promise<void>;
  resume(): void;
  stop(): void;
  destroy(error?: Error): void;
}

export declare function intersectBufferedRanges(
  left: readonly MseBufferedRange[],
  right: readonly MseBufferedRange[],
): MseBufferedRange[];

export declare function nextBufferedRange(
  ranges: readonly MseBufferedRange[],
  time: number,
  minimumDuration?: number,
  tolerance?: number,
): MseBufferedRange | null;

export declare function finalizeMseMediaSource(
  mediaSource: MediaSource,
  queues: MseAppendQueue[],
  options?: FinalizeMseMediaSourceOptions,
): Promise<{truncatedTo: number | null}>;

export default MseAppendQueue;
