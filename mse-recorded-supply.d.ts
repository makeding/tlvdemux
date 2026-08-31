import type {RecordedSource} from './recorded-source';

export declare function runMseRecordedSupply(options: {
  source: Pick<RecordedSource, 'stream'> & {size?: bigint | null};
  startOffset?: bigint;
  signal?: AbortSignal | null;
  isActive?: () => boolean;
  consume: (fragment: {data: Uint8Array; offset: bigint}) => unknown | Promise<unknown>;
  onProgress?: (progress: {
    nextOffset: bigint;
    bytesRead: bigint;
    fragmentOffset: bigint;
    fragmentBytes: number;
  }) => void;
}): Promise<{nextOffset: bigint; bytesRead: bigint}>;
