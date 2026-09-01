function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs one cancellable sequential Recorded/File input stream. Random reads stay
 * owned by duration probing and explicit seek; normal playback only advances
 * the returned nextOffset.
 */
export async function runMseRecordedSupply({
  source,
  startOffset = 0n,
  signal = null,
  isActive = () => true,
  consume,
  onProgress = () => {},
}) {
  if (!source?.stream || typeof consume !== 'function') {
    throw new TypeError('Recorded supply requires source.stream() and consume().');
  }
  let nextOffset = BigInt(startOffset);
  let bytesRead = 0n;
  const active = () => !signal?.aborted && isActive();
  if (!active()) throw abortError();
  for await (const data of source.stream(nextOffset, {signal})) {
    if (!active()) throw abortError();
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error(`Recorded source produced an empty fragment at ${nextOffset}.`);
    }
    const fragmentOffset = nextOffset;
    await consume({data, offset: fragmentOffset});
    if (!active()) throw abortError();
    const length = BigInt(data.byteLength);
    nextOffset += length;
    bytesRead += length;
    onProgress({nextOffset, bytesRead, fragmentOffset, fragmentBytes: data.byteLength});
  }
  if (!active()) throw abortError();
  if (source.size !== null && nextOffset !== source.size) {
    throw new Error(`Recorded source ended at ${nextOffset}; expected ${source.size}.`);
  }
  return {nextOffset, bytesRead};
}
