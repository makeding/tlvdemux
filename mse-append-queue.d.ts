export interface MseAppendQueueOptions {
  retryDelayMilliseconds?: number;
  backBufferSeconds?: number;
  forwardBufferHighSeconds?: number;
  trimGranularitySeconds?: number;
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
  readonly waiters: unknown[];
  error: Error | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  trimBeforeTime: number | null;
  forceTrim: boolean;
  state: 'running' | 'quiescing' | 'idle' | 'destroyed';
  onUpdateEnd: (() => void) | null;
  scheduledTimestampOffsetSeconds: number;
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
  pump(): void;
  bufferedAhead(): number;
  bufferedRanges(): MseBufferedRange[];
  snapshot(): {
    state: string;
    updating: boolean;
    mutationInProgress: boolean;
    pendingMutations: number;
    pendingAppends: number;
    pendingReconfigurations: number;
    queuedBytes: number;
    currentBytes: number;
    buffered: MseBufferedRange[];
  };
  trimBefore(time: number, force?: boolean): void;
  waitBelow(limit: number): Promise<void>;
  isForwardBlocked(): boolean;
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
