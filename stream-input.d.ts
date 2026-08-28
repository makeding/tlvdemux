export declare function coalesceReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: {
    targetBytes?: number;
    maxDelayMilliseconds?: number;
    now?: () => number;
  },
): AsyncGenerator<Uint8Array, void, void>;
