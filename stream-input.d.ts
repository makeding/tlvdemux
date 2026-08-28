export declare function coalesceReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: {
    targetBytes?: number;
    maxDelayMilliseconds?: number;
    now?: () => number;
  },
): AsyncGenerator<Uint8Array, void, void>;

export interface BoundedLiveTransitionInput {
  readonly candidateActive: boolean;
  beginCandidate(pushCandidate: (data: Uint8Array) => unknown | Promise<unknown>): number;
  cancelCandidate(generation?: number): boolean;
  push(data: Uint8Array): Promise<{
    active: true;
    candidate: boolean;
    candidateError?: unknown;
  }>;
}

export declare function createBoundedLiveTransitionInput(options: {
  pushActive: (data: Uint8Array) => unknown | Promise<unknown>;
  onCandidateFailure?: (error: unknown, generation: number) => void;
}): BoundedLiveTransitionInput;
