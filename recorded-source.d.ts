export declare class RangeUnsupportedError extends Error {}
export interface ContentRange {start: bigint; end: bigint; size: bigint;}
export declare function parseContentRange(value: string | null): ContentRange | null;
export interface RecordedSource {
  identity: unknown;
  label: string;
  size: bigint;
  read(offset: bigint, length: bigint): Promise<Uint8Array>;
}
export interface DurationProbeRangeRequest {
  requestId: bigint | number;
  offset: bigint | number;
  length: bigint | number;
}
export interface RecordedDuration {
  value: bigint | number;
  timescale: number;
}
export interface RecordedDurationProbe {
  begin(size: bigint, options?: Record<string, unknown>): boolean | Promise<boolean>;
  state(): string | Promise<string>;
  failure(): string | Promise<string>;
  nextRange(): DurationProbeRangeRequest | null | Promise<DurationProbeRangeRequest | null>;
  pushRange(
    id: bigint,
    offset: bigint,
    data: Uint8Array,
    end: boolean,
  ): boolean | Promise<boolean>;
  failRange?(id: bigint): unknown | Promise<unknown>;
  cancel?(): unknown | Promise<unknown>;
  duration(): RecordedDuration | null | Promise<RecordedDuration | null>;
  selectedVideoPacketId?(): number | null | Promise<number | null>;
  transferredBytes?(): bigint | Promise<bigint>;
  isDeleted?(): boolean;
  delete?(): void;
}
export declare function createBlobRecordedSource(
  blob: Blob,
  options?: {identity?: unknown; label?: string},
): RecordedSource;
export declare function openHttpRecordedSource(options: {
  url: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  requestInit?: Omit<RequestInit, 'headers'>;
  signal?: AbortSignal | null;
  identity?: unknown;
  label?: string;
}): Promise<RecordedSource>;
export declare function probeRecordedDuration(options: {
  source: RecordedSource;
  probe: RecordedDurationProbe;
  options?: Record<string, unknown>;
  signal?: AbortSignal | null;
  isActive?: () => boolean;
  onRange?: (range: {number: number; requestId: bigint; offset: bigint; length: bigint}) => void;
  onProgress?: (progress: {number: number; transferredBytes: bigint | null}) => void;
}): Promise<{
  duration: RecordedDuration;
  selectedVideoPacketId: number | null;
  transferredBytes: bigint | null;
  rangeCount: number;
}>;
