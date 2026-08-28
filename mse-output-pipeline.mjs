import {MseAppendQueue, finalizeMseMediaSource} from './mse-append-queue.mjs';

export const MSE_OUTPUT_PENDING_LIMIT_BYTES = 4 * 1024 * 1024;
const MSE_FRESH_RECORDED_PENDING_LIMIT_BYTES = 16 * 1024 * 1024;

export function createMseOutputPipeline({
  mediaSource,
  media,
  queues = new Map(),
  queueFactory = (type, init, onUpdateEnd, options) => new MseAppendQueue(
    mediaSource, media, init.mime, onUpdateEnd, options,
  ),
  onUpdateEnd = null,
  onQueueCreated = () => {},
  onInitObserved = () => {},
  onInitInstalled = () => {},
  onFirstSegment = () => {},
  onSplice = () => {},
  forceReinitialize = () => false,
  queueOptions = {},
  freshRecordedEntryAlignment = false,
  pendingBytesLimit = null,
}) {
  const pendingInits = new Map();
  const pendingSplices = new Map();
  const pendingSegments = new Map([['video', []], ['audio', []]]);
  const segmentTypes = new Set();
  const resolvedPendingBytesLimit = pendingBytesLimit ?? (freshRecordedEntryAlignment
    ? MSE_FRESH_RECORDED_PENDING_LIMIT_BYTES
    : MSE_OUTPUT_PENDING_LIMIT_BYTES);

  const pendingBytes = type => (pendingSegments.get(type) ?? [])
    .reduce((sum, segment) => sum + segment.data.byteLength, 0);

  const appendSegment = segment => {
    const queue = queues.get(segment.type);
    if (!queue) {
      const pending = pendingSegments.get(segment.type);
      if (!pending) throw new Error(`Unsupported MSE segment type: ${segment.type}`);
      pending.push(segment);
      if (pendingBytes(segment.type) > resolvedPendingBytesLimit) {
        throw new Error(`${segment.type} media exceeded the initialization wait limit.`);
      }
      return;
    }
    queue.append(segment.data, {
      startTimeSeconds: Number(segment.startTimeUs) / 1000000,
      endTimeSeconds: Number(segment.endTimeUs) / 1000000,
    });
  };

  const firstCommonEntryUs = () => {
    let earliest = null;
    for (const video of pendingSegments.get('video')) {
      for (const audio of pendingSegments.get('audio')) {
        const start = BigInt(video.startTimeUs) > BigInt(audio.startTimeUs)
          ? BigInt(video.startTimeUs) : BigInt(audio.startTimeUs);
        const end = BigInt(video.endTimeUs) < BigInt(audio.endTimeUs)
          ? BigInt(video.endTimeUs) : BigInt(audio.endTimeUs);
        if (end > start && (earliest === null || start < earliest)) earliest = start;
      }
    }
    return earliest;
  };

  const installPairedInits = () => {
    if (queues.size || !pendingInits.has('video') || !pendingInits.has('audio')) return false;
    let entryTimestampOffsetSeconds = null;
    if (freshRecordedEntryAlignment) {
      if (pendingSplices.size > 0) {
        if (!pendingSplices.has('video') || !pendingSplices.has('audio')) return false;
      } else {
        const entryUs = firstCommonEntryUs();
        if (entryUs === null) return false;
        entryTimestampOffsetSeconds = -Number(entryUs) / 1000000;
      }
    }
    for (const type of ['video', 'audio']) {
      const init = pendingInits.get(type);
      const queue = queueFactory(type, init, onUpdateEnd, queueOptions);
      queues.set(type, queue);
      onQueueCreated(type, queue);
      const splice = pendingSplices.get(type);
      if (splice) {
        queue.setTimestampOffset(splice.timestampOffsetSeconds);
        pendingSplices.delete(type);
      } else if (entryTimestampOffsetSeconds !== null) {
        queue.setTimestampOffset(entryTimestampOffsetSeconds);
      }
    }
    for (const type of ['video', 'audio']) {
      const init = pendingInits.get(type);
      queues.get(type).append(init.data);
      onInitInstalled(init, queues.get(type), false);
    }
    pendingInits.clear();
    for (const type of ['video', 'audio']) {
      for (const segment of pendingSegments.get(type)) appendSegment(segment);
      pendingSegments.get(type).length = 0;
    }
    return true;
  };

  const onMseInit = init => {
    onInitObserved(init);
    if (queues.size) {
      const queue = queues.get(init.type);
      if (!queue) throw new Error(`Missing ${init.type} SourceBuffer for ${init.mime}.`);
      queue.appendInitialization(init.data, init.mime, forceReinitialize(init.type, init));
      onInitInstalled(init, queue, true);
      return;
    }
    pendingInits.set(init.type, init);
    installPairedInits();
  };

  const onMseSegment = segment => {
    if (!segmentTypes.has(segment.type)) {
      segmentTypes.add(segment.type);
      onFirstSegment(segment.type, segment);
    }
    appendSegment(segment);
    installPairedInits();
  };

  const splice = (type, detail) => {
    const sourceBoundarySeconds = Number(detail.presentationTimeUs) / 1000000;
    const timestampOffsetSeconds = Number(detail.timestampOffsetUs ?? 0n) / 1000000;
    const outputBoundarySeconds = Math.max(0, sourceBoundarySeconds + timestampOffsetSeconds);
    const queue = queues.get(type);
    if (queue) {
      queue.spliceFrom(outputBoundarySeconds, timestampOffsetSeconds);
    } else {
      pendingInits.delete(type);
      pendingSegments.get(type).length = 0;
      pendingSplices.set(type, {timestampOffsetSeconds});
    }
    onSplice({
      type,
      sourceBoundarySeconds,
      outputBoundarySeconds,
      timestampOffsetSeconds,
      detail,
    });
  };

  return {
    queues,
    onMseInit,
    onMseSegment,
    onMseVideoSplice: detail => splice('video', detail),
    onMseAudioSplice: detail => splice('audio', detail),
    clearPendingMedia(type = null) {
      const types = type === null ? ['video', 'audio'] : [type];
      for (const selected of types) pendingSegments.get(selected)?.splice(0);
    },
    async waitStable() {
      await Promise.all([...queues.values()].map(queue => queue.waitStable()));
    },
    async finalize(options = {}) {
      return finalizeMseMediaSource(mediaSource, [...queues.values()], options);
    },
    pendingState() {
      return {
        initTypes: [...pendingInits.keys()],
        spliceTypes: [...pendingSplices.keys()],
        segmentBytes: Object.fromEntries(
          [...pendingSegments.keys()].map(type => [type, pendingBytes(type)]),
        ),
      };
    },
  };
}
