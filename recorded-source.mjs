export class RangeUnsupportedError extends Error {
  constructor(message = 'The source does not support strict HTTP byte ranges.') {
    super(message);
    this.name = 'RangeUnsupportedError';
  }
}

import {coalesceReadableStream} from './stream-input.mjs';

const DEFAULT_STREAM_TARGET_BYTES = 512 * 1024;
const DEFAULT_STREAM_MAX_DELAY_MILLISECONDS = 25;

export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value || '');
  if (!match) return null;
  return {start: BigInt(match[1]), end: BigInt(match[2]), size: BigInt(match[3])};
}

export function createBlobRecordedSource(blob, {identity = blob, label = blob.name ?? 'blob'} = {}) {
  return {
    identity,
    label,
    size: BigInt(blob.size),
    async read(offset, length) {
      if (offset < 0n || length <= 0n || offset + length > BigInt(blob.size)) {
        throw new RangeError(`Requested Blob range ${offset}+${length} exceeds source size ${blob.size}.`);
      }
      const start = Number(offset);
      const end = Number(offset + length);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
        throw new RangeError('Blob range exceeds the safe integer range.');
      }
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
    async *stream(offset = 0n, {
      signal = null,
      targetBytes = DEFAULT_STREAM_TARGET_BYTES,
      maxDelayMilliseconds = DEFAULT_STREAM_MAX_DELAY_MILLISECONDS,
    } = {}) {
      if (offset < 0n || offset > BigInt(blob.size)) {
        throw new RangeError(`Requested Blob stream offset ${offset} exceeds source size ${blob.size}.`);
      }
      if (signal?.aborted) throw abortError();
      const start = Number(offset);
      if (!Number.isSafeInteger(start)) throw new RangeError('Blob stream offset exceeds the safe integer range.');
      const reader = blob.slice(start).stream().getReader();
      const abort = () => void reader.cancel(abortError()).catch(() => {});
      signal?.addEventListener('abort', abort, {once: true});
      try {
        yield* coalesceReadableStream(reader, {targetBytes, maxDelayMilliseconds});
        if (signal?.aborted) throw abortError();
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

export async function openHttpRecordedSource({
  url,
  fetch: fetchImpl = globalThis.fetch,
  headers = {},
  requestInit = {},
  signal = null,
  identity = url,
  label = url,
}) {
  const request = async (offset, length) => {
    if (offset < 0n || length <= 0n) {
      throw new RangeError(`Invalid Range request ${offset}+${length}.`);
    }
    const end = offset + length - 1n;
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Range', `bytes=${offset}-${end}`);
    const response = await fetchImpl(url, {
      ...requestInit,
      headers: requestHeaders,
      signal: signal ?? requestInit.signal,
    });
    const returned = parseContentRange(response.headers.get('Content-Range'));
    if (response.status !== 206 || !returned || returned.start !== offset || returned.end !== end ||
        returned.size <= returned.end) {
      await response.body?.cancel();
      throw new RangeUnsupportedError(`Invalid Range response for bytes ${offset}-${end}.`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (BigInt(data.byteLength) !== length) {
      throw new RangeUnsupportedError(
        `Range body length mismatch at ${offset}: expected ${length}, received ${data.byteLength}.`);
    }
    return {data, size: returned.size};
  };
  const discovery = await request(0n, 1n);
  const size = discovery.size;
  return {
    identity,
    label,
    size,
    async read(offset, length) {
      if (offset < 0n || length <= 0n || offset + length > size) {
        throw new RangeError(`Requested Range ${offset}+${length} exceeds source size ${size}.`);
      }
      const result = await request(offset, length);
      if (result.size !== size) {
        throw new RangeUnsupportedError(`Source size changed from ${size} to ${result.size}.`);
      }
      return result.data;
    },
    async *stream(offset = 0n, {
      signal: streamSignal = null,
      targetBytes = DEFAULT_STREAM_TARGET_BYTES,
      maxDelayMilliseconds = DEFAULT_STREAM_MAX_DELAY_MILLISECONDS,
    } = {}) {
      if (offset < 0n || offset > size) {
        throw new RangeError(`Requested HTTP stream offset ${offset} exceeds source size ${size}.`);
      }
      if (offset === size) return;
      const requestHeaders = new Headers(headers);
      requestHeaders.set('Range', `bytes=${offset}-`);
      const response = await fetchImpl(url, {
        ...requestInit,
        headers: requestHeaders,
        signal: streamSignal ?? signal ?? requestInit.signal,
      });
      const returned = parseContentRange(response.headers.get('Content-Range'));
      if (response.status !== 206 || !response.body || !returned ||
          returned.start !== offset || returned.end !== size - 1n || returned.size !== size) {
        await response.body?.cancel();
        throw new RangeUnsupportedError(`Invalid streaming Range response for bytes ${offset}-.`);
      }
      yield* coalesceReadableStream(response.body.getReader(), {
        targetBytes, maxDelayMilliseconds,
      });
    },
  };
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export async function probeRecordedDuration({
  source,
  probe,
  options = {},
  signal = null,
  isActive = () => true,
  onRange = () => {},
  onProgress = () => {},
}) {
  const active = () => !signal?.aborted && isActive();
  let rangeNumber = 0;
  try {
    if (!active()) throw abortError();
    if (!await probe.begin(source.size, options)) {
      throw new Error(`Duration probe could not start: ${await probe.failure()}.`);
    }
    while (await probe.state() === 'need-range') {
      if (!active()) {
        await probe.cancel?.();
        throw abortError();
      }
      const request = await probe.nextRange();
      if (!request) throw new Error('Duration probe omitted its next Range request.');
      rangeNumber += 1;
      const requestId = BigInt(request.requestId);
      const offset = BigInt(request.offset);
      const length = BigInt(request.length);
      onRange({number: rangeNumber, requestId, offset, length});
      let data;
      try {
        data = await source.read(offset, length);
      } catch (error) {
        await probe.failRange?.(requestId);
        throw error;
      }
      if (!active()) {
        await probe.cancel?.();
        throw abortError();
      }
      if (!await probe.pushRange(requestId, offset, data, true)) {
        throw new Error(`Duration probe rejected Range #${rangeNumber}.`);
      }
      onProgress({
        number: rangeNumber,
        transferredBytes: typeof probe.transferredBytes === 'function'
          ? await probe.transferredBytes() : null,
      });
    }
    const state = await probe.state();
    if (state !== 'complete') {
      throw new Error(`Duration probe did not complete: ${state} / ${await probe.failure()}.`);
    }
    const duration = await probe.duration();
    if (!duration) throw new Error('Duration probe completed without a duration.');
    const presentationStart = await probe.presentationStart();
    const presentationEnd = await probe.presentationEnd();
    if (!presentationStart || !presentationEnd) {
      throw new Error('Duration probe completed without a presentation range.');
    }
    return {
      duration,
      presentationStart,
      presentationEnd,
      selectedVideoPacketId: typeof probe.selectedVideoPacketId === 'function'
        ? await probe.selectedVideoPacketId() : null,
      presentationEndVideoPacketId: typeof probe.presentationEndVideoPacketId === 'function'
        ? await probe.presentationEndVideoPacketId() : null,
      transferredBytes: typeof probe.transferredBytes === 'function'
        ? await probe.transferredBytes() : null,
      rangeCount: rangeNumber,
    };
  } finally {
    if (typeof probe.isDeleted !== 'function' || !probe.isDeleted()) probe.delete?.();
  }
}
