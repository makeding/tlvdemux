const DEFAULT_RETRY_DELAY_MILLISECONDS = 250;
const DEFAULT_BACK_BUFFER_SECONDS = 8;
const DEFAULT_TRIM_GRANULARITY_SECONDS = 2;

function snapshotTimeRanges(ranges) {
  const result = [];
  for (let index = 0; index < ranges.length; index += 1) {
    result.push({ start: ranges.start(index), end: ranges.end(index) });
  }
  return result;
}

function mergeTimeRanges(ranges) {
  const sorted = ranges
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) &&
      range.end > range.start)
    .map(range => ({start: range.start, end: range.end}))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + Number.EPSILON) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function subtractTimeRange(ranges, start, end) {
  if (!(end > start)) return ranges.map(range => ({...range}));
  const remaining = [];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) {
      remaining.push({...range});
      continue;
    }
    if (range.start < start) remaining.push({start: range.start, end: start});
    if (range.end > end) remaining.push({start: end, end: range.end});
  }
  return remaining;
}

function defaultMediaError(media) {
  if (!media.error) return '';
  return `MediaError code=${media.error.code}`;
}

/**
 * Serializes SourceBuffer mutations and applies byte/time backpressure.
 *
 * queuedBytes deliberately includes the append currently owned by the
 * SourceBuffer. updateend recomputes it from the remaining queue because the
 * event can also be emitted by abort() and remove(), where subtracting the
 * last append size would make the accounting drift.
 */
export class MseAppendQueue {
  constructor(mediaSource, mediaElement, mime, onUpdateEnd = null, options = {}) {
    const MediaSourceClass = globalThis.ManagedMediaSource ?? globalThis.MediaSource;
    if (!MediaSourceClass?.isTypeSupported(mime)) {
      throw new Error(`Unsupported MSE type: ${mime}`);
    }

    this.mediaElement = mediaElement;
    this.mediaSource = mediaSource;
    this.mime = mime;
    this.sourceBuffer = mediaSource.addSourceBuffer(mime);
    this.sourceBuffer.mode = 'segments';
    this.queue = [];
    this.queuedBytes = 0;
    this.currentBytes = 0;
    this.currentOperation = null;
    this.committedMediaRanges = [];
    this.waiters = [];
    this.error = null;
    this.retryTimer = null;
    this.trimBeforeTime = null;
    this.forceTrim = false;
    this.state = 'running';
    this.onUpdateEnd = onUpdateEnd;
    this.scheduledTimestampOffsetSeconds = this.sourceBuffer.timestampOffset || 0;
    this.retryDelayMilliseconds = options.retryDelayMilliseconds ?? DEFAULT_RETRY_DELAY_MILLISECONDS;
    this.backBufferSeconds = options.backBufferSeconds ?? DEFAULT_BACK_BUFFER_SECONDS;
    this.trimGranularitySeconds = options.trimGranularitySeconds ?? DEFAULT_TRIM_GRANULARITY_SECONDS;
    this.getMediaError = options.getMediaError ?? defaultMediaError;
    this.destroyOnSourceClose = options.destroyOnSourceClose ?? true;

    this.sourceBuffer.addEventListener('updateend', () => {
      const operation = this.currentOperation;
      this.currentOperation = null;
      if (operation?.kind === 'append' && operation.mime === null &&
          operation.startTimeSeconds !== null && operation.endTimeSeconds !== null) {
        this.committedMediaRanges = mergeTimeRanges([
          ...this.committedMediaRanges,
          {start: operation.startTimeSeconds, end: operation.endTimeSeconds},
        ]);
      } else if (operation?.kind === 'remove') {
        this.committedMediaRanges = subtractTimeRange(
          this.committedMediaRanges,
          operation.startTimeSeconds,
          operation.endTimeSeconds,
        );
      }
      this.currentBytes = 0;
      this.recountQueuedBytes();
      try {
        if (this.state === 'quiescing') this.state = 'idle';
        else this.pump();
        this.onUpdateEnd?.();
      } catch (error) {
        this.fail(error);
      } finally {
        this.resolveWaiters();
      }
    });
    this.sourceBuffer.addEventListener('error', () => {
      this.currentOperation = null;
      this.fail(new Error(this.getMediaError(this.mediaElement) || `SourceBuffer error: ${mime}`));
    });
    this.mediaSource.addEventListener('sourceclose', () => {
      if (this.destroyOnSourceClose && this.state !== 'destroyed') {
        this.destroy(new Error('MediaSource closed'));
      }
    });
  }

  append(data, timing = {}) {
    const mapTime = value => value === null || value === undefined
      ? null : value + this.scheduledTimestampOffsetSeconds;
    this.enqueueAppend({
      kind: 'append',
      data,
      mime: null,
      startTimeSeconds: mapTime(timing.startTimeSeconds),
      endTimeSeconds: mapTime(timing.endTimeSeconds),
    });
  }

  appendInitialization(data, mime, forceChangeType = false) {
    this.enqueueAppend({
      kind: 'append', data, mime, forceChangeType,
      startTimeSeconds: null, endTimeSeconds: null,
    });
  }

  setTimestampOffset(offsetSeconds) {
    if (!Number.isFinite(offsetSeconds)) {
      throw new TypeError(`invalid timestamp offset ${offsetSeconds}`);
    }
    if (this.error) throw this.error;
    if (this.state !== 'running') {
      throw new DOMException(`SourceBuffer queue is ${this.state}`, 'InvalidStateError');
    }
    this.scheduledTimestampOffsetSeconds = offsetSeconds;
    this.enqueueOperation({kind: 'timestamp-offset', offsetSeconds});
    this.pump();
  }

  spliceFrom(time, offsetSeconds) {
    if (!Number.isFinite(time) || time < 0) throw new TypeError(`invalid splice time ${time}`);
    if (!Number.isFinite(offsetSeconds)) {
      throw new TypeError(`invalid timestamp offset ${offsetSeconds}`);
    }
    if (this.error) throw this.error;
    if (this.state !== 'running') {
      throw new DOMException(`SourceBuffer queue is ${this.state}`, 'InvalidStateError');
    }
    this.queue = this.queue.filter(item => {
      const keep = item.kind !== 'append' ||
        (item.mime === null &&
         (item.startTimeSeconds === null || item.startTimeSeconds < time));
      return keep;
    });
    this.enqueueOperation({kind: 'remove', startTimeSeconds: time});
    this.scheduledTimestampOffsetSeconds = offsetSeconds;
    this.enqueueOperation({kind: 'timestamp-offset', offsetSeconds});
    this.recountQueuedBytes();
    this.pump();
  }

  replaceFrom(time) {
    if (!Number.isFinite(time) || time < 0) throw new TypeError(`invalid splice time ${time}`);
    if (this.error) throw this.error;
    if (this.state !== 'running') {
      throw new DOMException(`SourceBuffer queue is ${this.state}`, 'InvalidStateError');
    }
    this.queue = this.queue.filter(item => {
      const keep = item.kind !== 'append' ||
        (item.mime === null &&
         (item.startTimeSeconds === null || item.startTimeSeconds < time));
      return keep;
    });
    this.enqueueOperation({ kind: 'remove', startTimeSeconds: time });
    this.recountQueuedBytes();
    this.pump();
  }

  removeRange(start, end) {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
      throw new TypeError(`invalid remove range ${start}..${end}`);
    }
    if (this.error) throw this.error;
    if (this.state !== 'running') {
      throw new DOMException(`SourceBuffer queue is ${this.state}`, 'InvalidStateError');
    }
    this.enqueueOperation({
      kind: 'remove', startTimeSeconds: start, endTimeSeconds: end,
    });
    this.pump();
  }

  enqueueAppend(item) {
    if (this.error) throw this.error;
    if (this.state !== 'running') {
      throw new DOMException(`SourceBuffer queue is ${this.state}`, 'InvalidStateError');
    }
    this.enqueueOperation(item);
    this.queuedBytes += item.data.byteLength;
    this.pump();
  }

  enqueueOperation(item) {
    this.queue.push(item);
  }

  pump() {
    if (this.error || this.state !== 'running' || this.sourceBuffer.updating) return;
    const mediaFailure = this.getMediaError(this.mediaElement);
    if (mediaFailure) {
      this.fail(new Error(mediaFailure));
      return;
    }
    if (this.mediaSource.readyState !== 'open' ||
        !Array.from(this.mediaSource.sourceBuffers).includes(this.sourceBuffer)) {
      this.destroy(new Error('SourceBuffer is detached'));
      return;
    }

    const ranges = this.bufferedRanges();
    if (this.trimBeforeTime !== null && ranges.length) {
      const requestedEnd = this.trimBeforeTime;
      const start = ranges[0].start;
      const removeEnd = Math.min(requestedEnd, ranges[ranges.length - 1].end);
      const force = this.forceTrim;
      this.trimBeforeTime = null;
      this.forceTrim = false;
      const minimumEnd = force ? start : start + this.trimGranularitySeconds;
      if (removeEnd > minimumEnd) {
        this.currentOperation = {
          kind: 'remove', startTimeSeconds: start, endTimeSeconds: removeEnd,
        };
        this.sourceBuffer.remove(start, removeEnd);
        return;
      }
    }
    if (!this.queue.length) return;
    const item = this.queue.shift();
    if (item.kind === 'timestamp-offset') {
      this.sourceBuffer.timestampOffset = item.offsetSeconds;
      this.pump();
      return;
    }
    if (item.kind === 'remove') {
      const bufferedEnd = this.bufferedRanges().at(-1)?.end;
      const removeEnd = Number.isFinite(item.endTimeSeconds)
        ? Math.min(item.endTimeSeconds, bufferedEnd ?? item.endTimeSeconds)
        : bufferedEnd;
      if (Number.isFinite(removeEnd) && removeEnd > item.startTimeSeconds) {
        this.currentOperation = {
          kind: 'remove', startTimeSeconds: item.startTimeSeconds,
          endTimeSeconds: removeEnd,
        };
        this.sourceBuffer.remove(item.startTimeSeconds, removeEnd);
        return;
      }
      this.committedMediaRanges = subtractTimeRange(
        this.committedMediaRanges,
        item.startTimeSeconds,
        item.endTimeSeconds ?? Infinity,
      );
      this.pump();
      return;
    }
    const data = item.data;
    this.currentBytes = data.byteLength;
    try {
      if (item.mime !== null && (item.forceChangeType || item.mime !== this.mime)) {
        if (typeof this.sourceBuffer.changeType !== 'function') {
          throw new Error('SourceBuffer.changeType is not supported in this browser');
        }
        this.sourceBuffer.changeType(item.mime);
        this.mime = item.mime;
      }
      this.currentOperation = item;
      this.sourceBuffer.appendBuffer(data);
    } catch (error) {
      this.currentOperation = null;
      this.queue.unshift(item);
      this.currentBytes = 0;
      this.recountQueuedBytes();
      if (error?.name === 'QuotaExceededError') {
        this.trimBefore(this.mediaElement.currentTime - this.backBufferSeconds, true);
        this.scheduleRetry();
      } else {
        this.fail(error);
      }
    }
  }

  bufferedAhead() {
    const ranges = this.bufferedRanges();
    const time = this.mediaElement.currentTime;
    for (const range of ranges) {
      if (range.start <= time + 0.1 && range.end >= time) return range.end - time;
    }
    return 0;
  }

  bufferedRanges() {
    try {
      return snapshotTimeRanges(this.sourceBuffer.buffered);
    } catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      return snapshotTimeRanges(this.mediaElement.buffered);
    }
  }

  committedRanges() {
    return this.committedMediaRanges.map(range => ({...range}));
  }

  trimBefore(time, force = false) {
    if (!(time > 0) || this.state !== 'running') return;
    if (!force && this.trimBeforeTime === null) {
      const ranges = this.bufferedRanges();
      if (!ranges.length || time <= ranges[0].start + this.trimGranularitySeconds) return;
    }
    this.trimBeforeTime = this.trimBeforeTime === null ? time : Math.max(this.trimBeforeTime, time);
    this.forceTrim ||= force;
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.retryTimer !== null || this.state !== 'running') return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      try {
        this.pump();
      } catch (error) {
        this.fail(error);
      }
    }, this.retryDelayMilliseconds);
  }

  waitBelow(limit) {
    if (this.error) return Promise.reject(this.error);
    if (this.queuedBytes <= limit) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ limit, idle: false, resolve, reject }));
  }

  isStable() {
    return this.isIdle();
  }

  waitStable() {
    if (this.error) return Promise.reject(this.error);
    if (this.isStable()) return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.waiters.push({stable: true, resolve, reject}));
  }

  isFlowControlled(limit) {
    return this.queuedBytes <= limit;
  }

  waitFlowControlled(limit) {
    if (this.error) return Promise.reject(this.error);
    if (this.isFlowControlled(limit)) return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.waiters.push({flowLimit: limit, resolve, reject}));
  }

  isIdle() {
    return !this.sourceBuffer.updating && this.queuedBytes === 0 &&
      this.queue.length === 0 && this.trimBeforeTime === null;
  }

  waitIdle() {
    if (this.error) return Promise.reject(this.error);
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ idle: true, resolve, reject }));
  }

  async quiesce() {
    if (this.error) throw this.error;
    this.state = 'quiescing';
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.trimBeforeTime = null;
    this.forceTrim = false;
    this.queue = [];
    this.queuedBytes = this.currentBytes;
    if (!this.sourceBuffer.updating) {
      this.currentBytes = 0;
      this.queuedBytes = 0;
      this.state = 'idle';
    }
    this.resolveWaiters();
    await this.waitIdle();
  }

  resume() {
    if (this.error || this.state === 'destroyed') return;
    this.state = 'running';
    this.pump();
  }

  stop() {
    this.destroy();
  }

  destroy(error = new Error('SourceBuffer queue stopped')) {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.state = 'destroyed';
    this.error ||= error;
    this.queue = [];
    this.queuedBytes = 0;
    this.currentBytes = 0;
    this.currentOperation = null;
    this.committedMediaRanges = [];
    this.trimBeforeTime = null;
    this.forceTrim = false;
    this.resolveWaiters();
  }

  recountQueuedBytes() {
    this.queuedBytes = this.currentBytes +
      this.queue.reduce((sum, item) => sum + (item.data?.byteLength || 0), 0);
  }

  fail(error) {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.resolveWaiters();
  }

  resolveWaiters() {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (this.error) waiter.reject(this.error);
      else if (waiter.flowLimit !== undefined ? this.isFlowControlled(waiter.flowLimit)
        : waiter.stable ? this.isStable()
        : waiter.idle ? this.isIdle()
        : this.queuedBytes <= waiter.limit) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
}

export function intersectBufferedRanges(left, right) {
  const result = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const start = Math.max(left[leftIndex].start, right[rightIndex].start);
    const end = Math.min(left[leftIndex].end, right[rightIndex].end);
    if (end > start) result.push({ start, end });
    if (left[leftIndex].end < right[rightIndex].end) leftIndex += 1;
    else rightIndex += 1;
  }
  return result;
}

export function nextBufferedRange(ranges, time, minimumDuration = 0, tolerance = 0.05) {
  if (ranges.some(range =>
    range.start <= time + tolerance && range.end > time + tolerance)) return null;
  return ranges.find(range =>
    range.start > time + tolerance && range.end - range.start >= minimumDuration) ?? null;
}

/** Waits for all queues and closes a MediaSource on a stable A/V boundary. */
export async function finalizeMseMediaSource(mediaSource, queues, options = {}) {
  await Promise.all(queues.map(queue => queue.waitIdle()));
  let truncatedTo = null;
  if (options.truncateToCommonEnd && queues.length > 1) {
    let common = queues[0].bufferedRanges();
    for (let index = 1; index < queues.length && common.length; index += 1) {
      common = intersectBufferedRanges(common, queues[index].bufferedRanges());
    }
    const commonEnd = common.at(-1)?.end;
    const minimumTruncationSeconds = options.minimumTruncationSeconds ?? 0.05;
    if (Number.isFinite(commonEnd) && Number.isFinite(mediaSource.duration) &&
        mediaSource.duration - commonEnd > minimumTruncationSeconds) {
      // Chromium rejects duration reduction while any coded frame still ends
      // beyond the requested value. Remove those tails first, then commit the
      // shorter duration once every SourceBuffer has completed its mutation.
      for (const queue of queues) {
        const ranges = queue.bufferedRanges();
        const bufferedEnd = ranges.at(-1)?.end;
        if (Number.isFinite(bufferedEnd) && bufferedEnd > commonEnd) {
          queue.removeRange(commonEnd, bufferedEnd);
        }
      }
      await Promise.all(queues.map(queue => queue.waitIdle()));
      mediaSource.duration = commonEnd;
      truncatedTo = commonEnd;
    }
  }
  if (mediaSource.readyState === 'open') mediaSource.endOfStream();
  return { truncatedTo };
}

export default MseAppendQueue;
