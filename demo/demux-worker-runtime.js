importScripts('./demux-worker-protocol.js');

const protocol = globalThis.TlvDemuxWorkerProtocol;
const applicationDrainBatch = 32;
const objects = new Map();
let modulePromise = null;
let operationQueue = Promise.resolve();

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}

function sendFailure(requestId, error) {
  postMessage({ type: protocol.failure, requestId, error: serializeError(error) });
}

function sendEvent(objectId, name, value, transfer = []) {
  postMessage({ type: protocol.event, objectId, name, value }, transfer);
}

function copyBytes(source) {
  const output = new Uint8Array(source?.byteLength || 0);
  if (output.byteLength) output.set(source);
  return output;
}

function transferAccessUnit(objectId, unit) {
  if (unit.codec === 'hevc' && !unit.randomAccess && !unit.discontinuity) return;
  if (unit.codec === 'aac-latm' && !unit.discontinuity) return;
  const data = unit.codec === 'ttml' ? copyBytes(unit.data) : new Uint8Array(0);
  const resources = (unit.subtitleResources || []).map(resource => ({
    ...resource,
    data: copyBytes(resource.data),
  }));
  const value = { ...unit, data, subtitleResources: resources };
  const transfer = [data.buffer, ...resources.map(resource => resource.data.buffer)];
  sendEvent(objectId, 'onAccessUnitView', value, transfer);
}

function trackGroup(track, groupIdentification = null, selectionLevel = null) {
  return track?.assetGroups?.find(group =>
    (groupIdentification === null || group.groupIdentification === groupIdentification) &&
    (selectionLevel === null || group.selectionLevel === selectionLevel)) ?? null;
}

function rememberSelection(record, kind, track, groupIdentification = null) {
  const group = trackGroup(track, groupIdentification);
  record.selection[`${kind}Track`] = track.trackId;
  record.selection[`${kind}PacketId`] = track.packetId;
  record.selection[`${kind}Identity`] = {
    contextId: track.contextId,
    componentTag: track.componentTag,
    groupIdentification: group?.groupIdentification ?? null,
    selectionLevel: group?.selectionLevel ?? null,
  };
}

function defaultTrack(tracks, kind, targetLevel, maxAudioChannels) {
  let candidates = tracks.filter(track => track.kind === kind);
  if (kind === 'audio' && maxAudioChannels > 0) {
    candidates = candidates.filter(track =>
      Number(track.audio?.channels || 0) <= maxAudioChannels);
  }
  if (targetLevel !== null) {
    const atLevel = candidates.filter(track => trackGroup(track, null, targetLevel));
    if (atLevel.length) candidates = atLevel;
  }
  const defaultTag = kind === 'video' ? 0x00 : kind === 'audio' ? 0x10 : 0x30;
  return candidates.sort((left, right) =>
    (left.componentTag === defaultTag ? 0 : 1) -
      (right.componentTag === defaultTag ? 0 : 1) ||
    left.componentTag - right.componentTag || left.packetId - right.packetId)[0] ?? null;
}

function replacementTrack(tracks, kind, identity, targetLevel, maxAudioChannels) {
  let candidates = tracks.filter(track =>
    track.kind === kind && track.contextId === identity.contextId);
  if (kind === 'audio' && maxAudioChannels > 0) {
    candidates = candidates.filter(track =>
      Number(track.audio?.channels || 0) <= maxAudioChannels);
  }
  if (identity.groupIdentification !== null) {
    const grouped = candidates.filter(track => trackGroup(
      track, identity.groupIdentification, targetLevel));
    if (grouped.length) candidates = grouped;
  } else if (targetLevel !== null) {
    const atLevel = candidates.filter(track => trackGroup(track, null, targetLevel));
    if (atLevel.length) candidates = atLevel;
  }
  const exact = candidates.find(track => track.componentTag === identity.componentTag);
  return exact ?? candidates.sort((left, right) =>
    left.componentTag - right.componentTag || left.packetId - right.packetId)[0] ?? null;
}

function reconcileMptSelection(record, snapshot) {
  const tracks = snapshot.tracks || [];
  const selectedVideo = tracks.find(track =>
    track.trackId === record.selection.videoTrack) ?? null;
  const previousVideo = record.tracks.get(record.selection.videoTrack);
  const videoLevel = trackGroup(selectedVideo ?? previousVideo)?.selectionLevel ?? null;

  for (const kind of ['video', 'audio', 'subtitle']) {
    const selectedId = record.selection[`${kind}Track`];
    if (selectedId === null || tracks.some(track => track.trackId === selectedId)) continue;
    const identity = record.selection[`${kind}Identity`];
    const targetLevel = kind === 'video' ? identity?.selectionLevel ?? null : videoLevel;
    const replacement = identity
      ? replacementTrack(tracks, kind, identity, targetLevel,
        record.selection.maxAudioChannels)
      : null;
    const target = replacement ?? defaultTrack(
      tracks, kind, targetLevel, record.selection.maxAudioChannels);
    record.instance.selectTrack(kind, target?.trackId ?? null);
    if (target) rememberSelection(record, kind, target, identity?.groupIdentification ?? null);
    else {
      record.selection[`${kind}Track`] = null;
      record.selection[`${kind}Identity`] = null;
    }
  }
}

function automaticSelection(record, track) {
  const selection = record.selection;
  if (track.kind === 'video') {
    if (selection.videoTrack !== null) return;
    if (selection.videoPacketId !== null && track.packetId !== selection.videoPacketId) return;
    record.instance.selectTrack('video', track.trackId);
    rememberSelection(record, 'video', track);
    return;
  }
  if (track.kind === 'audio') {
    const channels = Number(track.audio?.channels || 0);
    if (selection.maxAudioChannels > 0 && channels > selection.maxAudioChannels) return;
    const preferred = selection.audioPacketId;
    if (selection.audioTrack !== null && (preferred === null || track.packetId !== preferred)) {
      return;
    }
    record.instance.selectTrack('audio', track.trackId);
    rememberSelection(record, 'audio', track);
    return;
  }
  if (track.kind === 'subtitle' && track.codec === 'ttml') {
    if (track.subtitle?.type !== 0) return;
    const preferred = selection.subtitlePacketId;
    if (selection.subtitleTrack !== null &&
        (preferred === null || track.packetId !== preferred)) return;
    record.instance.selectTrack('subtitle', track.trackId);
    rememberSelection(record, 'subtitle', track);
  }
}

function createDemuxer(module, objectId, options) {
  const record = {
    type: 'demuxer',
    module,
    instance: null,
    inputAddress: 0,
    inputCapacity: 0,
    applicationDrainScheduled: false,
    applicationDrainError: null,
    selection: {
      videoPacketId: options.videoPacketId ?? null,
      audioPacketId: options.audioPacketId ?? null,
      subtitlePacketId: options.subtitlePacketId ?? null,
      maxAudioChannels: Number(options.mseMaxAudioChannels || 0),
      videoTrack: null,
      audioTrack: null,
      subtitleTrack: null,
      videoIdentity: null,
      audioIdentity: null,
      subtitleIdentity: null,
    },
    tracks: new Map(),
  };
  const event = (name, transform = value => value) => value => {
    sendEvent(objectId, name, transform(value));
  };
  record.instance = new module.TlvDemuxer({
    mseMaxAudioChannels: record.selection.maxAudioChannels,
    onMseVideoStart: event('onMseVideoStart'),
    onMseVideoSplice: event('onMseVideoSplice'),
    onMseAudioSplice: event('onMseAudioSplice'),
    onMseLayerSwitch: event('onMseLayerSwitch'),
    onMseLayerSwitchCancelled(cancelled) {
      for (const [kind, trackId] of [
        ['video', cancelled.previousVideoTrackId],
        ['audio', cancelled.previousAudioTrackId],
      ]) {
        const track = trackId === 0n ? null : record.tracks.get(trackId);
        if (track) rememberSelection(record, kind, track);
        else {
          record.selection[`${kind}Track`] = trackId === 0n ? null : trackId;
          record.selection[`${kind}Identity`] = null;
        }
      }
      sendEvent(objectId, 'onMseLayerSwitchCancelled', cancelled);
    },
    onMseInit(init) {
      sendEvent(objectId, 'onMseInit', init, [init.data.buffer]);
    },
    onMseSegment(segment) {
      sendEvent(objectId, 'onMseSegment', segment, [segment.data.buffer]);
    },
    onService: event('onService'),
    onTrack(track) {
      record.tracks.set(track.trackId, track);
      automaticSelection(record, track);
      sendEvent(objectId, 'onTrack', track);
    },
    onTrackRemoved(track) {
      record.tracks.delete(track.trackId);
      sendEvent(objectId, 'onTrackRemoved', track);
    },
    onMptSnapshot(snapshot) {
      reconcileMptSelection(record, snapshot);
      sendEvent(objectId, 'onMptSnapshot', snapshot);
    },
    onLayoutConfiguration: event('onLayoutConfiguration'),
    onApplicationService: event('onApplicationService'),
    onDataAsset: event('onDataAsset'),
    onSignallingMessage: event('onSignallingMessage'),
    onBroadcastClock: event('onBroadcastClock'),
    onEventInfo: event('onEventInfo'),
    onStreamEvent: event('onStreamEvent'),
    onViewerParticipationNotification: event('onViewerParticipationNotification'),
    onApplicationResourceView(resource) {
      const data = copyBytes(resource.data);
      sendEvent(objectId, 'onApplicationResourceView', { ...resource, data }, [data.buffer]);
    },
    onApplicationResourceRemoved: event('onApplicationResourceRemoved'),
    onApplicationRemoved: event('onApplicationRemoved'),
    onApplicationState(state) {
      sendEvent(objectId, 'onApplicationState', {
        ...state,
        applicationEntry: record.instance.applicationEntry(state.contextId),
      });
    },
    onApplicationResourcesReset: event('onApplicationResourcesReset'),
    onPlaybackAccessUnitView(unit) {
      transferAccessUnit(objectId, unit);
    },
    onError: event('onError'),
  });
  return record;
}

function ensureInputCapacity(record, byteLength) {
  if (byteLength <= record.inputCapacity) return;
  const allocationUnit = 64 * 1024;
  const capacity = Math.ceil(byteLength / allocationUnit) * allocationUnit;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`invalid demux input size: ${byteLength}`);
  }
  const address = record.module._malloc(capacity);
  if (!address) throw new RangeError(`cannot allocate ${capacity} bytes of WASM input memory`);
  if (record.inputAddress) record.module._free(record.inputAddress);
  record.inputAddress = address;
  record.inputCapacity = capacity;
}

function pushDemuxBytes(record, bytes) {
  const byteLength = Number(bytes?.byteLength || 0);
  if (byteLength === 0) return record.instance.pushFromHeap(0, 0);
  ensureInputCapacity(record, byteLength);
  record.module.HEAPU8.set(bytes, record.inputAddress);
  return record.instance.pushFromHeap(record.inputAddress, byteLength);
}

function scheduleApplicationDrain(record) {
  if (record.applicationDrainScheduled) return;
  record.applicationDrainScheduled = true;
  setTimeout(() => {
    operationQueue = operationQueue.then(() => {
      record.applicationDrainScheduled = false;
      if (objects.get(record.objectId) !== record) return;
      try {
        drainApplications(record, false);
      } catch (error) {
        record.applicationDrainError = error;
      }
    });
  }, 0);
}

function drainApplications(record, exhaustive) {
  if (record.type !== 'demuxer') return;
  let more = record.instance.drainApplicationResources(applicationDrainBatch);
  if (exhaustive) {
    while (more) {
      more = record.instance.drainApplicationResources(applicationDrainBatch);
    }
  } else if (more) {
    // Application decompression remains in the worker, but yields between
    // batches so a large carousel cannot indefinitely delay media input.
    scheduleApplicationDrain(record);
  }
}

async function initialize(message) {
  if (!modulePromise) {
    importScripts(message.wasmUrl);
    if (typeof createTlvDemuxModule !== 'function') {
      throw new Error(`WASM factory was not exported by ${message.wasmUrl}`);
    }
    modulePromise = createTlvDemuxModule();
  }
  await modulePromise;
  postMessage({ type: protocol.ready, requestId: message.requestId });
}

async function createObject(message) {
  const module = await modulePromise;
  let record;
  if (message.objectType === 'duration-probe') {
    record = { type: 'duration-probe', instance: new module.DurationProbe() };
  } else if (message.objectType === 'demuxer') {
    record = createDemuxer(module, message.objectId, message.options || {});
  } else {
    throw new Error(`unknown worker object type: ${message.objectType}`);
  }
  record.objectId = message.objectId;
  objects.set(message.objectId, record);
  postMessage({ type: protocol.result, requestId: message.requestId, value: true });
}

function configureSelection(record, options) {
  const selection = record.selection;
  if ('videoPacketId' in options) selection.videoPacketId = options.videoPacketId ?? null;
  if ('audioPacketId' in options) selection.audioPacketId = options.audioPacketId ?? null;
  if ('subtitlePacketId' in options) {
    selection.subtitlePacketId = options.subtitlePacketId ?? null;
  }
  return true;
}

async function invokeObject(message) {
  const record = objects.get(message.objectId);
  if (!record) throw new Error(`worker object ${message.objectId} does not exist`);
  if (record.applicationDrainError) throw record.applicationDrainError;
  let value;
  if (message.method === 'configureTrackSelection') {
    if (record.type !== 'demuxer') throw new Error('track selection requires a demuxer');
    value = configureSelection(record, message.args[0] || {});
  } else {
    if (record.type === 'demuxer' && message.method === 'push') {
      value = pushDemuxBytes(record, message.args?.[0]);
    } else {
      const method = record.instance[message.method];
      if (typeof method !== 'function') {
        throw new Error(`unknown ${record.type} method: ${message.method}`);
      }
      value = method.apply(record.instance, message.args || []);
      if (record.type === 'demuxer' &&
          (message.method === 'selectTrack' ||
           (message.method === 'switchAudioTrack' && value !== null) ||
           (message.method === 'switchLayer' && value === true))) {
        const selections = message.method === 'switchLayer'
          ? [['video', message.args?.[0]], ['audio', message.args?.[1]]]
          : [message.method === 'selectTrack'
              ? (message.args || []) : ['audio', message.args?.[0]]];
        for (const [kind, trackId] of selections) {
          const key = `${kind}Track`;
          if (key in record.selection) {
            const track = record.tracks.get(trackId);
            const packetKey = `${kind}PacketId`;
            if (track) rememberSelection(record, kind, track);
            else {
              record.selection[key] = trackId ?? null;
              record.selection[`${kind}Identity`] = null;
              if (packetKey in record.selection && trackId == null) {
                record.selection[packetKey] = null;
              }
            }
          }
        }
      }
    }
    if (message.method === 'push' || message.method === 'flush') {
      drainApplications(record, message.method === 'flush');
    }
  }
  postMessage({ type: protocol.result, requestId: message.requestId, value });
}

async function destroyObject(message) {
  const record = objects.get(message.objectId);
  if (record) {
    if (record.inputAddress) record.module._free(record.inputAddress);
    record.instance.delete();
    objects.delete(message.objectId);
  }
  postMessage({ type: protocol.result, requestId: message.requestId, value: true });
}

async function dispatch(message) {
  try {
    if (message.type === protocol.init) await initialize(message);
    else if (message.type === protocol.create) await createObject(message);
    else if (message.type === protocol.invoke) await invokeObject(message);
    else if (message.type === protocol.destroy) await destroyObject(message);
  } catch (error) {
    sendFailure(message.requestId, error);
  }
}

self.onmessage = event => {
  operationQueue = operationQueue.then(() => dispatch(event.data));
};
