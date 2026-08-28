function joinChunks(chunks, byteLength) {
  if (chunks.length === 1) return chunks[0];
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function* coalesceReadableStream(reader, {
  targetBytes = 512 * 1024,
  maxDelayMilliseconds = 25,
  now = () => performance.now(),
} = {}) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new TypeError('targetBytes must be a positive safe integer');
  }
  if (!Number.isFinite(maxDelayMilliseconds) || maxDelayMilliseconds < 0) {
    throw new TypeError('maxDelayMilliseconds must be a non-negative number');
  }
  let pendingRead = reader.read();
  let chunks = [];
  let chunkBytes = 0;
  let flushDeadline = 0;
  const flush = () => {
    const output = joinChunks(chunks, chunkBytes);
    chunks = [];
    chunkBytes = 0;
    flushDeadline = 0;
    return output;
  };
  try {
    while (true) {
      let result;
      if (chunkBytes === 0) {
        result = {kind: 'read', value: await pendingRead};
      } else {
        const remaining = Math.max(0, flushDeadline - now());
        result = await Promise.race([
          pendingRead.then(value => ({kind: 'read', value})),
          new Promise(resolve => setTimeout(() => resolve({kind: 'deadline'}), remaining)),
        ]);
      }
      if (result.kind === 'deadline') {
        yield flush();
        continue;
      }
      const {done, value} = result.value;
      if (done) {
        if (chunkBytes !== 0) yield flush();
        break;
      }
      pendingRead = reader.read();
      if (!value?.byteLength) continue;
      if (chunkBytes === 0 && value.byteLength >= targetBytes) {
        yield value;
        continue;
      }
      if (chunkBytes === 0) flushDeadline = now() + maxDelayMilliseconds;
      chunks.push(value);
      chunkBytes += value.byteLength;
      if (chunkBytes >= targetBytes) yield flush();
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fans each live input chunk to the current playback consumer and, while a
 * transition is armed, one candidate consumer. No media is retained between
 * calls: candidate backpressure is awaited and failure detaches only the
 * candidate, leaving the current playback input uninterrupted.
 */
export function createBoundedLiveTransitionInput({
  pushActive,
  onCandidateFailure = () => {},
}) {
  if (typeof pushActive !== 'function') throw new TypeError('pushActive is required');
  let candidate = null;
  let generation = 0;
  return {
    get candidateActive() { return candidate !== null; },
    beginCandidate(pushCandidate) {
      if (typeof pushCandidate !== 'function') throw new TypeError('pushCandidate is required');
      generation += 1;
      candidate = {push: pushCandidate, generation};
      return generation;
    },
    cancelCandidate(candidateGeneration = generation) {
      if (candidate?.generation !== candidateGeneration) return false;
      candidate = null;
      return true;
    },
    async push(data) {
      await pushActive(data);
      const pending = candidate;
      if (!pending) return {active: true, candidate: false};
      try {
        await pending.push(data);
        return {active: true, candidate: candidate?.generation === pending.generation};
      } catch (error) {
        if (candidate?.generation === pending.generation) candidate = null;
        onCandidateFailure(error, pending.generation);
        return {active: true, candidate: false, candidateError: error};
      }
    },
  };
}
