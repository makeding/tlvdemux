export const TLV_DEMUX_WORKER_PROTOCOL = Object.freeze({
  init: 'tlvdemux:init',
  ready: 'tlvdemux:ready',
  create: 'tlvdemux:create',
  invoke: 'tlvdemux:invoke',
  destroy: 'tlvdemux:destroy',
  result: 'tlvdemux:result',
  event: 'tlvdemux:event',
  failure: 'tlvdemux:failure',
});

const protocol = TLV_DEMUX_WORKER_PROTOCOL;

export function workerResultValue(message) {
  return 'value' in message ? message.value : true;
}

function remoteError(value) {
  const error = new Error(value?.message || 'tlvdemux worker failed');
  error.name = value?.name || 'Error';
  if (value?.code !== undefined) error.code = value.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

function applicationKey(state) {
  return `${state.contextId}:${state.organizationId}:${state.applicationId}`;
}

function resourceKey(contextId, path) {
  return `${contextId}:${path}`;
}

function createObjectCache(callbacks) {
  return {
    callbacks,
    entries: new Map(),
    applications: new Map(),
    resources: new Map(),
    broadcastClock: null,
    layoutConfiguration: null,
  };
}

class WorkerClient {
  constructor({ workerUrl, wasmUrl, workerFactory }) {
    this.worker = workerFactory(workerUrl);
    this.nextRequestId = 1;
    this.nextObjectId = 1;
    this.closed = false;
    this.pending = new Map();
    this.caches = new Map();
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => this.failAll(
      new Error(event.message || 'tlvdemux worker crashed'));
    this.ready = this.request(protocol.init, { wasmUrl });
  }

  receive(message) {
    if (message.type === protocol.event) {
      const cache = this.caches.get(message.objectId);
      if (!cache) return;
      this.updateCache(cache, message.name, message.value);
      const callback = cache.callbacks?.[message.name];
      if (typeof callback === 'function') callback(message.value);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === protocol.failure) pending.reject(remoteError(message.error));
    else pending.resolve(workerResultValue(message));
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(type, fields = {}, transfer = []) {
    if (this.closed) {
      return Promise.reject(new DOMException('tlvdemux worker closed', 'AbortError'));
    }
    const requestId = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.worker.postMessage({ type, requestId, ...fields }, transfer);
    return promise;
  }

  async create(objectType, callbacks = null, options = {}) {
    await this.ready;
    const objectId = this.nextObjectId++;
    if (callbacks) this.caches.set(objectId, createObjectCache(callbacks));
    try {
      await this.request(protocol.create, { objectId, objectType, options });
      return objectId;
    } catch (error) {
      this.caches.delete(objectId);
      throw error;
    }
  }

  async invoke(objectId, method, args = [], transfer = []) {
    await this.ready;
    return this.request(protocol.invoke, { objectId, method, args }, transfer);
  }

  destroy(objectId) {
    this.caches.delete(objectId);
    if (!this.closed) void this.request(protocol.destroy, { objectId }).catch(() => {});
  }

  cache(objectId) { return this.caches.get(objectId); }

  updateCache(cache, name, value) {
    if (name === 'onApplicationState') {
      cache.applications.set(applicationKey(value), value);
      if (value.applicationEntry) cache.entries.set(value.contextId, value.applicationEntry);
      else cache.entries.delete(value.contextId);
    } else if (name === 'onApplicationResourceView') {
      cache.resources.set(resourceKey(value.contextId, value.path), value);
    } else if (name === 'onApplicationResourceRemoved') {
      cache.resources.delete(resourceKey(value.contextId, value.path));
    } else if (name === 'onApplicationRemoved') {
      cache.applications.delete(applicationKey(value));
    } else if (name === 'onApplicationResourcesReset') {
      cache.entries.clear();
      cache.applications.clear();
      cache.resources.clear();
    } else if (name === 'onBroadcastClock') {
      cache.broadcastClock = value;
    } else if (name === 'onLayoutConfiguration') {
      cache.layoutConfiguration = value;
    } else if (name === 'onServiceStateReset') {
      cache.layoutConfiguration = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll(new DOMException('tlvdemux worker closed', 'AbortError'));
    this.caches.clear();
  }
}

class WorkerObject {
  constructor(client, objectType, callbacks = null, options = {}) {
    this.client = client;
    this.objectId = null;
    this.closed = false;
    this.ready = client.create(objectType, callbacks, options).then(objectId => {
      this.objectId = objectId;
      return objectId;
    });
  }

  async call(method, args = [], transfer = []) {
    const objectId = await this.ready;
    if (this.closed) throw new DOMException('worker object is closed', 'InvalidStateError');
    return this.client.invoke(objectId, method, args, transfer);
  }

  delete() {
    if (this.closed) return;
    this.closed = true;
    if (this.objectId !== null) this.client.destroy(this.objectId);
    else void this.ready.then(objectId => this.client.destroy(objectId)).catch(() => {});
  }

  isDeleted() { return this.closed; }
}

class WorkerDurationProbe extends WorkerObject {
  constructor(client) { super(client, 'duration-probe'); }
  begin(size, options) { return this.call('begin', [size, options]); }
  nextRange() { return this.call('nextRange'); }
  failRange(requestId) { return this.call('failRange', [requestId]); }
  cancel() { return this.call('cancel'); }
  state() { return this.call('state'); }
  failure() { return this.call('failure'); }
  duration() { return this.call('duration'); }
  presentationStart() { return this.call('presentationStart'); }
  presentationEnd() { return this.call('presentationEnd'); }
  selectedVideoPacketId() { return this.call('selectedVideoPacketId'); }
  presentationEndVideoPacketId() { return this.call('presentationEndVideoPacketId'); }
  transferredBytes() { return this.call('transferredBytes'); }
  pushRange(requestId, offset, bytes, endOfRange) {
    // Worker transfer lists detach their ArrayBuffer in the caller. Source
    // implementations and recorded-seek sessions are allowed to retain and
    // reuse public API input, so transfer only an SDK-owned copy.
    const data = bytes.slice();
    return this.call('pushRange', [requestId, offset, data, endOfRange], [data.buffer]);
  }
}

class WorkerDemuxer extends WorkerObject {
  constructor(client, callbacks, options = {}) {
    super(client, 'demuxer', callbacks, {
      mseMaxAudioChannels: callbacks?.mseMaxAudioChannels || 0,
      ...options,
    });
  }

  initialized() { return this.ready.then(() => undefined); }
  configureTrackSelection(options) {
    return this.call('configureTrackSelection', [options]);
  }
  push(bytes) {
    const data = bytes.slice();
    return this.call('push', [data], [data.buffer]);
  }
  flush() { return this.call('flush'); }
  reset() { return this.call('reset'); }
  reposition(offset, preserveTimeline) {
    return this.call('reposition', [offset, preserveTimeline]);
  }
  selectService(contextId) { return this.call('selectService', [contextId]); }
  selectTrack(kind, trackId) { return this.call('selectTrack', [kind, trackId]); }
  switchAudioTrack(trackId, earliestPresentationTimeUs) {
    return this.call('switchAudioTrack', [trackId, earliestPresentationTimeUs]);
  }
  switchLayer(videoTrackId, audioTrackId, earliestPresentationTimeUs) {
    return this.call('switchLayer', [
      videoTrackId, audioTrackId, earliestPresentationTimeUs,
    ]);
  }
  switchLayerAtPlaybackEntry(videoTrackId, audioTrackId, playbackEntryTimeUs) {
    return this.call('switchLayerAtPlaybackEntry', [
      videoTrackId, audioTrackId, playbackEntryTimeUs,
    ]);
  }
  configureAutomaticLayerSwitch(
    preferredVideoTrackId, preferredAudioTrackId,
    fallbackVideoTrackId, fallbackAudioTrackId,
  ) {
    return this.call('configureAutomaticLayerSwitch', [
      preferredVideoTrackId, preferredAudioTrackId,
      fallbackVideoTrackId, fallbackAudioTrackId,
    ]);
  }
  suspendAutomaticLayerSwitch(
    preferredVideoTrackId, preferredAudioTrackId,
    fallbackVideoTrackId, fallbackAudioTrackId,
  ) {
    return this.call('suspendAutomaticLayerSwitch', [
      preferredVideoTrackId, preferredAudioTrackId,
      fallbackVideoTrackId, fallbackAudioTrackId,
    ]);
  }
  clearAutomaticLayerSwitch() { return this.call('clearAutomaticLayerSwitch'); }
  setMseTimestampOffset(timestampOffsetUs) {
    return this.call('setMseTimestampOffset', [timestampOffsetUs]);
  }
  setMseRecordedSeekConcealmentTarget(presentationTimeUs) {
    return this.call('setMseRecordedSeekConcealmentTarget', [presentationTimeUs]);
  }
  beginMseRecordedSeek() { return this.call('beginMseRecordedSeek'); }
  flushMseRecordedSeekLanding() { return this.call('flushMseRecordedSeekLanding'); }
  finishMseRecordedSeek(playbackPositionUs) {
    return this.call('finishMseRecordedSeek', [playbackPositionUs]);
  }
  cancelMseRecordedSeek() { return this.call('cancelMseRecordedSeek'); }
  setMsePlaybackPosition(presentationTimeUs) {
    return this.call('setMsePlaybackPosition', [presentationTimeUs]);
  }
  setMseSdrInHlg(videoTrackId, enabled) {
    return this.call('setMseSdrInHlg', [videoTrackId, enabled]);
  }
  setMseToneMappingMode(mode) {
    return this.call('setMseToneMappingMode', [mode]);
  }
  setMseEdid(edid) {
    const data = edid.slice();
    return this.call('setMseEdid', [data], [data.buffer]);
  }
  setMseOutputConnected(connected) {
    return this.call('setMseOutputConnected', [connected]);
  }
  hlgSdrToneMappingLut() { return this.call('hlgSdrToneMappingLut'); }
  hlgSdrColorLut() { return this.call('hlgSdrColorLut'); }
  hlgSdrPrototypeColorLut() { return this.call('hlgSdrPrototypeColorLut'); }
  setMseOutputEnabled(enabled) { return this.call('setMseOutputEnabled', [enabled]); }
  setSubtitlePassthroughEnabled(enabled) {
    return this.call('setSubtitlePassthroughEnabled', [enabled]);
  }
  startIndex(growing) { return this.call('startIndex', [growing]); }
  finalizeIndex() { return this.call('finalizeIndex'); }
  setIndexDuration(duration) { return this.call('setIndexDuration', [duration]); }
  estimateOffset(target, sourceSize) {
    return this.call('estimateOffset', [target, sourceSize]);
  }
  seekPointCount() { return this.call('seekPointCount'); }
  indexState() { return this.call('indexState'); }
  applicationEntry(contextId) {
    return this.cache()?.entries.get(contextId) ?? null;
  }
  applications() { return [...(this.cache()?.applications.values() ?? [])]; }
  broadcastClock() { return this.cache()?.broadcastClock ?? null; }
  layoutConfiguration() { return this.cache()?.layoutConfiguration ?? null; }
  applicationResources(contextId = undefined) {
    return [...(this.cache()?.resources.values() ?? [])]
      .filter(resource => contextId === undefined || resource.contextId === contextId)
      .map(resource => ({
        contextId: resource.contextId,
        componentTag: resource.componentTag,
        transactionId: resource.transactionId,
        downloadId: resource.downloadId,
        mpuSequenceNumber: resource.mpuSequenceNumber,
        itemId: resource.itemId,
        version: resource.version,
        path: resource.path,
        contentType: resource.contentType,
        size: resource.data.byteLength,
        generation: resource.generation,
      }));
  }
  applicationResource(contextId, path) {
    const resource = this.cache()?.resources.get(resourceKey(contextId, path));
    return resource ? {...resource, data: resource.data.slice()} : null;
  }
  cache() { return this.objectId === null ? undefined : this.client.cache(this.objectId); }
}

export async function createWorkerTlvDemuxModule(options = {}) {
  const client = new WorkerClient({
    workerUrl: options.workerUrl || new URL(
      './worker/demux-worker-runtime.js', import.meta.url),
    wasmUrl: options.wasmUrl || new URL(
      './dist/tlvdemux.js', import.meta.url).href,
    workerFactory: options.workerFactory || (url => new Worker(url)),
  });
  try {
    await client.ready;
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    DurationProbe: class extends WorkerDurationProbe {
      constructor() { super(client); }
    },
    TlvDemuxer: class extends WorkerDemuxer {
      constructor(callbacks, objectOptions) { super(client, callbacks, objectOptions); }
    },
    close: () => client.close(),
  };
}
