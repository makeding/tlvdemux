import {MseAppendQueue, finalizeMseMediaSource} from './mse-append-queue.mjs';

export const MSE_OUTPUT_PENDING_LIMIT_BYTES = 4 * 1024 * 1024;
const MSE_FRESH_RECORDED_PENDING_LIMIT_BYTES = 16 * 1024 * 1024;

function normalizeRequiredTracks(requiredTracks) {
  const tracks = [...new Set(requiredTracks)];
  if (!tracks.length || tracks.some(type => type !== 'video' && type !== 'audio')) {
    throw new TypeError('requiredTracks must contain audio and/or video.');
  }
  return tracks;
}

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
  queueOptions = {},
  freshRecordedEntryAlignment = false,
  recordedPresentationStartUs = null,
  pendingBytesLimit = null,
  mode = 'audio-video',
  requiredTracks = mode === 'audio-only' ? ['audio'] : ['video', 'audio'],
  onInactiveOutput = () => {},
}) {
  const pendingInits = new Map();
  const pendingSplices = new Map();
  const pendingReconfigurations = new Set();
  const pendingSegments = new Map([['video', []], ['audio', []]]);
  const segmentTypes = new Set();
  let currentRequiredTracks = normalizeRequiredTracks(requiredTracks);
  let discardedBytes = 0;
  const resolvedPendingBytesLimit = pendingBytesLimit ?? (freshRecordedEntryAlignment
    ? MSE_FRESH_RECORDED_PENDING_LIMIT_BYTES
    : MSE_OUTPUT_PENDING_LIMIT_BYTES);

  const pendingBytes = type => (pendingSegments.get(type) ?? [])
    .reduce((sum, segment) => sum + segment.data.byteLength, 0);
  const required = type => currentRequiredTracks.includes(type);
  const requiredQueues = () => currentRequiredTracks
    .map(type => queues.get(type)).filter(Boolean);

  const discard = (kind, output) => {
    discardedBytes += output?.data?.byteLength ?? 0;
    onInactiveOutput({kind, type: output.type, byteLength: output?.data?.byteLength ?? 0});
  };

  const appendSegment = segment => {
    if (!required(segment.type)) {
      discard('segment', segment);
      return;
    }
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
    if (currentRequiredTracks.length === 1) {
      const segments = pendingSegments.get(currentRequiredTracks[0]);
      return segments.reduce((earliest, segment) => {
        const start = BigInt(segment.startTimeUs);
        return earliest === null || start < earliest ? start : earliest;
      }, null);
    }
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

  const installRequiredInits = () => {
    if (currentRequiredTracks.every(type => queues.has(type))) return false;
    if (currentRequiredTracks.some(type => queues.has(type)) ||
        !currentRequiredTracks.every(type => pendingInits.has(type))) return false;
    let entryTimestampOffsetSeconds = recordedPresentationStartUs === null
      ? null : -Number(BigInt(recordedPresentationStartUs)) / 1000000;
    if (freshRecordedEntryAlignment) {
      if (pendingSplices.size > 0) {
        if (!currentRequiredTracks.every(type => pendingSplices.has(type))) return false;
      } else {
        const entryUs = firstCommonEntryUs();
        if (entryUs === null) return false;
        if (entryTimestampOffsetSeconds === null) {
          entryTimestampOffsetSeconds = -Number(entryUs) / 1000000;
        }
      }
    }
    for (const type of currentRequiredTracks) {
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
    for (const type of currentRequiredTracks) {
      const init = pendingInits.get(type);
      queues.get(type).append(init.data);
      onInitInstalled(init, queues.get(type), false);
    }
    for (const type of currentRequiredTracks) pendingInits.delete(type);
    for (const type of currentRequiredTracks) {
      for (const segment of pendingSegments.get(type)) appendSegment(segment);
      pendingSegments.get(type).length = 0;
    }
    return true;
  };

  const onMseInit = init => {
    if (!required(init.type)) {
      pendingInits.delete(init.type);
      discard('init', init);
      return;
    }
    onInitObserved(init);
    if (queues.has(init.type)) {
      const queue = queues.get(init.type);
      if (!queue) throw new Error(`Missing ${init.type} SourceBuffer for ${init.mime}.`);
      const forceChangeType = pendingReconfigurations.has(init.type);
      queue.appendInitialization(init.data, init.mime, forceChangeType);
      pendingReconfigurations.delete(init.type);
      onInitInstalled(init, queue, true);
      return;
    }
    pendingInits.set(init.type, init);
    installRequiredInits();
  };

  const onMseSegment = segment => {
    if (required(segment.type) && !segmentTypes.has(segment.type)) {
      segmentTypes.add(segment.type);
      onFirstSegment(segment.type, segment);
    }
    appendSegment(segment);
    installRequiredInits();
  };

  const splice = (type, detail) => {
    if (!required(type)) {
      pendingInits.delete(type);
      pendingSegments.get(type).length = 0;
      pendingSplices.delete(type);
      discard('splice', {type, data: null});
      return;
    }
    const sourceBoundarySeconds = Number(detail.presentationTimeUs) / 1000000;
    const timestampOffsetSeconds = Number(detail.timestampOffsetUs ?? 0n) / 1000000;
    const outputBoundarySeconds = Math.max(0, sourceBoundarySeconds + timestampOffsetSeconds);
    const queue = queues.get(type);
    if (queue) {
      queue.spliceFrom(outputBoundarySeconds, timestampOffsetSeconds);
      pendingReconfigurations.add(type);
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
    get mode() {
      return currentRequiredTracks.length === 1 && currentRequiredTracks[0] === 'audio'
        ? 'audio-only' : 'audio-video';
    },
    get requiredTracks() { return [...currentRequiredTracks]; },
    setRequiredTracks(nextRequiredTracks) {
      currentRequiredTracks = normalizeRequiredTracks(nextRequiredTracks);
      for (const type of ['video', 'audio']) {
        if (!required(type)) {
          pendingInits.delete(type);
          pendingSplices.delete(type);
          pendingSegments.get(type).length = 0;
        }
      }
      installRequiredInits();
      return [...currentRequiredTracks];
    },
    onMseInit,
    onMseSegment,
    onMseVideoSplice: detail => splice('video', detail),
    onMseAudioSplice: detail => splice('audio', detail),
    clearPendingMedia(type = null) {
      const types = type === null ? ['video', 'audio'] : [type];
      for (const selected of types) pendingSegments.get(selected)?.splice(0);
    },
    async waitStable() {
      await Promise.all(requiredQueues().map(queue => queue.waitStable()));
    },
    async finalize(options = {}) {
      return finalizeMseMediaSource(mediaSource, requiredQueues(), options);
    },
    pendingState() {
      return {
        initTypes: [...pendingInits.keys()],
        spliceTypes: [...pendingSplices.keys()],
        segmentBytes: Object.fromEntries(
          [...pendingSegments.keys()].map(type => [type, pendingBytes(type)]),
        ),
        requiredTracks: [...currentRequiredTracks],
        discardedBytes,
      };
    },
  };
}

function collectionIncludes(collection, value) {
  return Array.from(collection ?? []).includes(value);
}

/**
 * Best-effort in-place video activation. Success is reported only after the
 * SourceBuffer's membership in activeSourceBuffers reflects the requested
 * state; callers must rebuild the MediaSource for every other result.
 */
export async function setMseVideoTrackActive({
  mediaSource,
  active,
  videoSourceBuffer = null,
  settle = () => new Promise(resolve => setTimeout(resolve, 0)),
}) {
  const sourceBuffers = Array.from(mediaSource?.sourceBuffers ?? []);
  const buffer = videoSourceBuffer ?? sourceBuffers.find(sourceBuffer =>
    Number(sourceBuffer?.videoTracks?.length ?? 0) > 0);
  if (!buffer || !buffer.videoTracks || !buffer.videoTracks.length ||
      !mediaSource?.activeSourceBuffers) {
    return {supported: false, changed: false, active, requiresRebuild: true};
  }
  const tracks = Array.from(buffer.videoTracks);
  if (!tracks.some(track => 'selected' in track)) {
    return {supported: false, changed: false, active, requiresRebuild: true};
  }
  if (active) {
    tracks.forEach((track, index) => { track.selected = index === 0; });
  } else {
    tracks.forEach(track => { track.selected = false; });
  }
  await settle();
  const observedActive = collectionIncludes(mediaSource.activeSourceBuffers, buffer);
  const changed = observedActive === active;
  return {
    supported: true,
    changed,
    active: observedActive,
    requiresRebuild: !changed,
    sourceBuffer: buffer,
  };
}
