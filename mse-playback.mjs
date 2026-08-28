import {intersectBufferedRanges} from './mse-append-queue.mjs';

export const MSE_STARTUP_NO_COMMON_AV = 'MSE_STARTUP_NO_COMMON_AV';
export const MSE_SEEK_NO_COMMON_AV = 'MSE_SEEK_NO_COMMON_AV';
export const MSE_SEEK_READ_BUDGET_BYTES = 16 * 1024 * 1024;

const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const ENTRY_TOLERANCE_SECONDS = 0.05;

export class MseStartupBufferError extends Error {
  constructor(message =
    'Audio and video could not be aligned with timestamp 0. Check the input and retry playback.') {
    super(`${MSE_STARTUP_NO_COMMON_AV}: ${message}`);
    this.name = 'MseStartupBufferError';
    this.code = MSE_STARTUP_NO_COMMON_AV;
  }
}

export class MseRecordedSeekError extends Error {
  constructor(reason = 'no-common-av', message = null) {
    const detail = message ?? ({
      'budget-exhausted':
        'The requested time did not form a common audio/video buffer within the 16 MiB seek budget.',
      'no-rap': 'No random access point at or before the requested time was found within the seek budget.',
      'no-common-av': 'Audio and video could not form a common buffer at the requested time.',
      'source-ended': 'The input ended before audio and video covered the requested time.',
      'demux-failed': 'The demuxer could not prepare the requested time.',
    }[reason] ?? 'The requested time could not be prepared.');
    super(`${MSE_SEEK_NO_COMMON_AV}: ${detail} Input reads have stopped; retry the seek or choose a nearby time.`);
    this.name = 'MseRecordedSeekError';
    this.code = MSE_SEEK_NO_COMMON_AV;
    this.reason = reason;
  }
}

export function commonBufferedRanges(queues) {
  let common = null;
  for (const queue of queues.values()) {
    const ranges = queue.bufferedRanges();
    common = common === null ? ranges : intersectBufferedRanges(common, ranges);
    if (!common.length) break;
  }
  return common ?? [];
}

function coveringRange(queues, timeSeconds, toleranceSeconds) {
  if (queues.size < 2) return null;
  return commonBufferedRanges(queues).find(range =>
    range.start <= timeSeconds + toleranceSeconds && range.end >= timeSeconds) ?? null;
}

export function commonBufferedAhead(media, queues, toleranceSeconds = ENTRY_TOLERANCE_SECONDS) {
  const range = coveringRange(queues, media.currentTime, toleranceSeconds);
  return range ? Math.max(0, range.end - media.currentTime) : 0;
}

export function startMsePlayback({
  media,
  queues,
  liveMode = false,
  minimumLiveBufferSeconds = 0,
  play = () => media.play(),
}) {
  const ranges = commonBufferedRanges(queues);
  if (!ranges.length) return null;
  const currentTime = media.currentTime;
  const range = liveMode
    ? ranges.find(item => item.end > currentTime + 0.001)
    : ranges.find(item => item.start <= currentTime + ENTRY_TOLERANCE_SECONDS &&
        item.end > currentTime + 0.001);
  if (!range) return null;
  const commonAhead = range.end - Math.max(currentTime, range.start);
  if (liveMode && commonAhead < minimumLiveBufferSeconds) return null;
  const aligned = liveMode && currentTime < range.start - 0.001;
  if (aligned) media.currentTime = range.start;
  return {range, commonAhead, aligned, playResult: play()};
}

export function createMsePlaybackDamageRecovery({
  media,
  presentationStartUs = 0n,
  isActive = () => true,
  isCurrentLayer = () => true,
  switchInFlight = () => false,
  isTargetBuffered = target => {
    const ranges = media.buffered;
    if (!ranges || typeof ranges.length !== 'number') return true;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= target + ENTRY_TOLERANCE_SECONDS &&
          ranges.end(index) >= target + 0.001) return true;
    }
    return false;
  },
  seek,
}) {
  const completedDamage = new Set();
  const pendingDamage = new Map();
  const randomAccessPoints = new Map();
  const frameObservationSupported =
    typeof media.requestVideoFrameCallback === 'function';
  let waitingTime = null;
  let waitingGeneration = 0;
  let lastPresentedTime = null;
  let frameCallbackId = null;
  let destroyed = false;
  const damageKey = damage => [
    damage.videoTrackId, damage.startInputOffset, damage.endInputOffset,
    damage.recoveryTimeUs, damage.recoveryInputOffset, damage.recoveryRestartOffset,
  ].map(value => String(value ?? '')).join(':');
  const trackKey = trackId => String(trackId);

  const rememberRandomAccessPoint = (trackId, target) => {
    if (!Number.isFinite(target) || target < 0) return;
    const key = trackKey(trackId);
    const points = randomAccessPoints.get(key) ?? [];
    if (!points.some(point => Math.abs(point - target) < 0.0005)) {
      points.push(target);
      points.sort((left, right) => left - right);
      if (points.length > 256) points.splice(0, points.length - 256);
      randomAccessPoints.set(key, points);
    }
  };

  const prepare = damage => {
    if ((damage.action !== 'seek' && damage.action !== 'seek-if-stalled') ||
        damage.recoveryTimeUs === null || damage.recoveryTimeUs === undefined ||
        !isActive() || !isCurrentLayer(damage) || switchInFlight()) return null;
    const target = Number(BigInt(damage.recoveryTimeUs) - BigInt(presentationStartUs)) / 1000000;
    if (!Number.isFinite(target) || target < 0) return null;
    const start = damage.startTimeUs === null || damage.startTimeUs === undefined
      ? null
      : Number(BigInt(damage.startTimeUs) - BigInt(presentationStartUs)) / 1000000;
    if (start !== null && (!Number.isFinite(start) || start < 0)) return null;
    if (damage.action === 'seek-if-stalled' &&
        (start === null || start > target)) return null;
    return {
      damage,
      key: damageKey(damage),
      target,
      start,
      action: damage.action,
      lastAttemptedTarget: null,
      lastAttemptWaitingGeneration: null,
    };
  };

  const recover = (candidate, target = candidate?.target) => {
    const ownsInFlightSeek = candidate?.action === 'seek-if-stalled' &&
      candidate.lastAttemptedTarget !== null &&
      Math.abs(media.currentTime - candidate.lastAttemptedTarget) <= 0.1;
    if (!candidate || completedDamage.has(candidate.key) ||
        !isActive() || !isCurrentLayer(candidate.damage) ||
        switchInFlight() || (media.seeking && !ownsInFlightSeek) || !Number.isFinite(target) ||
        target + 0.0005 < media.currentTime || !isTargetBuffered(target)) return null;
    const previousTime = media.currentTime;
    const resumeAfterSeek = !media.paused;
    const requiresPresentedFrame = candidate.action === 'seek-if-stalled' &&
      (frameObservationSupported || lastPresentedTime !== null);
    if (requiresPresentedFrame) {
      candidate.lastAttemptedTarget = target;
      candidate.lastAttemptWaitingGeneration = waitingGeneration;
    } else {
      completedDamage.add(candidate.key);
      pendingDamage.delete(candidate.key);
    }
    waitingTime = null;
    seek(target, previousTime, {
      action: candidate.action,
      damage: candidate.damage,
      firstRecoveryTime: candidate.target,
      lastPresentedTime,
      waitingTime: previousTime,
    });
    // Preserve the play intent captured before the SDK-owned currentTime
    // update. Some browsers expose `paused=true` immediately after that write,
    // which must not turn an automatic recovery into a manual play operation.
    if (resumeAfterSeek) {
      try {
        Promise.resolve(media.play()).catch(() => {});
      } catch (_) { /* A rejected resume remains observable on the MediaElement. */ }
    }
    return {start: target, end: target};
  };

  const retirePresentedDamage = () => {
    if (lastPresentedTime === null) return;
    for (const [key, candidate] of pendingDamage) {
      if (candidate.action === 'seek-if-stalled' &&
          lastPresentedTime + 0.001 >= candidate.target) {
        completedDamage.add(key);
        pendingDamage.delete(key);
      }
    }
  };

  const recoverWaiting = () => {
    if (waitingTime === null || destroyed || !isActive() ||
        switchInFlight()) return null;
    const currentTime = media.currentTime;
    const candidates = [...pendingDamage.values()]
      .filter(candidate => candidate.action === 'seek-if-stalled' &&
        !completedDamage.has(candidate.key) && isCurrentLayer(candidate.damage) &&
        candidate.start !== null && candidate.start <= currentTime + 0.1 &&
        candidate.lastAttemptWaitingGeneration !== waitingGeneration &&
        (lastPresentedTime === null || lastPresentedTime + 0.001 < candidate.target))
      .sort((left, right) => right.target - left.target);
    for (const candidate of candidates) {
      if (!frameObservationSupported && lastPresentedTime === null &&
          currentTime > candidate.target + 0.001) {
        pendingDamage.delete(candidate.key);
        continue;
      }
      const minimumTarget = Math.max(currentTime, candidate.target);
      const target = (randomAccessPoints.get(trackKey(candidate.damage.videoTrackId)) ?? [])
        .find(point => point + 0.0005 >= minimumTarget &&
          (candidate.lastAttemptedTarget === null ||
            point > candidate.lastAttemptedTarget + 0.0005) &&
          isTargetBuffered(point));
      if (target !== undefined) return recover(candidate, target);
    }
    return null;
  };

  const observePresentedFrame = mediaTime => {
    if (destroyed || !Number.isFinite(mediaTime)) return null;
    lastPresentedTime = lastPresentedTime === null
      ? mediaTime : Math.max(lastPresentedTime, mediaTime);
    retirePresentedDamage();
    if (waitingTime !== null && mediaTime + 0.001 >= waitingTime) waitingTime = null;
    return lastPresentedTime;
  };

  const scheduleFrameObservation = () => {
    if (destroyed || !frameObservationSupported) return;
    frameCallbackId = media.requestVideoFrameCallback((_now, metadata) => {
      frameCallbackId = null;
      observePresentedFrame(Number(metadata?.mediaTime));
      scheduleFrameObservation();
    });
  };
  scheduleFrameObservation();

  return {
    notifyWaiting() {
      const currentTime = media.currentTime;
      if (!isActive() || switchInFlight()) {
        waitingTime = null;
        return null;
      }
      waitingTime = currentTime;
      waitingGeneration += 1;
      for (const [key, item] of pendingDamage) {
        if (completedDamage.has(key) || !isCurrentLayer(item.damage)) {
          pendingDamage.delete(key);
        }
      }
      const shortRecovery = recoverWaiting();
      if (shortRecovery) return shortRecovery;
      const severe = [...pendingDamage.values()]
        .filter(item => item.action === 'seek' &&
          (item.start === null || item.start <= currentTime + 0.1))
        .sort((left, right) => left.target - right.target)[0] ?? null;
      return recover(severe);
    },
    notifyBufferedChange() {
      return recoverWaiting();
    },
    observeAccessUnit(unit) {
      if (destroyed || unit?.codec !== 'hevc' || !unit.randomAccess ||
          unit.ptsValue === null || unit.ptsValue === undefined ||
          !Number.isFinite(Number(unit.ptsTimescale)) || Number(unit.ptsTimescale) <= 0) return null;
      const sourceSeconds = Number(unit.ptsValue) / Number(unit.ptsTimescale);
      const target = sourceSeconds - Number(BigInt(presentationStartUs)) / 1000000;
      rememberRandomAccessPoint(unit.trackId, target);
      return recoverWaiting();
    },
    observePresentedFrame,
    destroy() {
      destroyed = true;
      if (frameCallbackId !== null && typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = null;
      completedDamage.clear();
      pendingDamage.clear();
      randomAccessPoints.clear();
      waitingTime = null;
      waitingGeneration = 0;
      lastPresentedTime = null;
    },
    reset() {
      completedDamage.clear();
      pendingDamage.clear();
      waitingTime = null;
      waitingGeneration = 0;
      lastPresentedTime = null;
    },
    reportDamage(damage) {
      const candidate = prepare(damage);
      if (!candidate || completedDamage.has(candidate.key)) return null;
      const existing = pendingDamage.get(candidate.key);
      if (existing) return existing.action === 'seek-if-stalled'
        ? recoverWaiting() : null;
      pendingDamage.set(candidate.key, candidate);
      rememberRandomAccessPoint(damage.videoTrackId, candidate.target);
      if (candidate.action === 'seek-if-stalled') {
        retirePresentedDamage();
        return recoverWaiting();
      }
      if (candidate.target < media.currentTime) return null;
      if (candidate.start === null || media.currentTime + 0.1 < candidate.start) return null;
      return recover(candidate);
    },
  };
}

export function createMsePlaybackFlowControl({
  media,
  queues,
  entryKind = 'startup',
  entryTimeSeconds = entryKind === 'startup' ? 0 : media.currentTime,
  entryToleranceSeconds = ENTRY_TOLERANCE_SECONDS,
  highSeconds = 15,
  lowSeconds = 8,
  startupNoProgressBytes = MSE_SEEK_READ_BUDGET_BYTES,
  queueHighBytes = 4 * 1024 * 1024,
  backBufferSeconds = 8,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (entryKind !== 'startup' && entryKind !== 'live' && entryKind !== 'seek') {
    throw new TypeError(`Unknown MSE playback entry kind: ${entryKind}`);
  }
  let startupBytes = 0;
  let entryCovered = false;
  const initialRanges = new Map([...queues].map(([type, queue]) => [
    type, JSON.stringify(queue.bufferedRanges()),
  ]));

  const trim = () => {
    for (const queue of queues.values()) queue.trimBefore(media.currentTime - backBufferSeconds);
  };
  const perTrackRanges = () => [...queues.values()].map(queue => queue.bufferedRanges());
  const liveEntryRange = () => commonBufferedRanges(queues).find(range =>
    range.end > media.currentTime + 0.001) ?? null;

  const classifyUncoveredEntry = () => {
    if (queues.size < 2) return null;
    const ranges = perTrackRanges();
    if (!ranges.every(items => items.length > 0)) return null;
    if (entryKind === 'startup' || entryKind === 'live') return null;
    const hasNewSeekMedia = [...queues].every(([type, queue]) =>
      JSON.stringify(queue.bufferedRanges()) !== initialRanges.get(type));
    if (!hasNewSeekMedia) return null;
    const common = commonBufferedRanges(queues);
    if (common.some(range => range.start > entryTimeSeconds + entryToleranceSeconds) ||
        ranges.every(items => items.at(-1).end > entryTimeSeconds + entryToleranceSeconds)) {
      return new MseRecordedSeekError('no-common-av');
    }
    return null;
  };

  const api = {
    entryKind,
    entryTimeSeconds,
    entryRange() {
      if (entryKind === 'live') return liveEntryRange();
      return coveringRange(queues, entryTimeSeconds, entryToleranceSeconds);
    },
    entryCovered() {
      return entryCovered || api.entryRange() !== null;
    },
    commonAhead() {
      if (entryKind === 'live') {
        const range = liveEntryRange();
        return range ? Math.max(0, range.end - Math.max(media.currentTime, range.start)) : 0;
      }
      return commonBufferedAhead(media, queues, entryToleranceSeconds);
    },
    async afterPush(byteLength, isActive = () => true) {
      trim();
      await Promise.all([...queues.values()].map(queue => queue.waitFlowControlled(queueHighBytes)));
      if (!isActive()) return {commonAhead: 0, entryCovered};

      const range = api.entryRange();
      if (range) {
        entryCovered = true;
      } else if (!entryCovered) {
        if (entryKind === 'startup' || entryKind === 'live') startupBytes += byteLength;
        const error = classifyUncoveredEntry();
        if (error) throw error;
        if ((entryKind === 'startup' || entryKind === 'live') &&
            startupBytes >= startupNoProgressBytes) {
          throw new MseStartupBufferError(
            entryKind === 'live'
              ? `${startupNoProgressBytes} bytes were read without forming a common live A/V range.`
              : `${startupNoProgressBytes} bytes were read without forming a common A/V range at timestamp 0.`);
        }
      }

      let ahead = api.commonAhead();
      if (!entryCovered || ahead < highSeconds) return {commonAhead: ahead, entryCovered};
      while (isActive() && ahead > lowSeconds) {
        trim();
        await wait(250);
        ahead = api.commonAhead();
      }
      return {commonAhead: ahead, entryCovered};
    },
  };
  return api;
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The seek was superseded.', 'AbortError');
  const error = new Error('The seek was superseded.');
  error.name = 'AbortError';
  return error;
}

function timestampUs(unit) {
  if (unit.ptsValue === undefined || !unit.ptsTimescale) return null;
  return BigInt(unit.ptsValue) * 1000000n / BigInt(unit.ptsTimescale);
}

function clampBigInt(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function createMseRecordedSeekSession({
  targetTimeSeconds,
  targetUs = BigInt(Math.round(targetTimeSeconds * 1000000)),
  durationUs,
  presentationStartUs = 0n,
  presentationEndUs = BigInt(presentationStartUs) + BigInt(durationUs),
  source,
  demuxer,
  media,
  queues,
  flowControl = createMsePlaybackFlowControl({
    media, queues, entryKind: 'seek', entryTimeSeconds: Number(targetUs) / 1000000,
  }),
  signal = null,
  isActive = () => true,
  headReady,
  candidateVideoTrack = track => track.kind === 'video',
  videoTrackPriority = () => 0,
  activateVideoTrack = async () => {},
  beforeLanding = async () => {},
  waitForAppends = async () => {
    await Promise.all([...queues.values()].map(queue => queue.waitStable?.() ?? Promise.resolve()));
  },
  checkError = () => {},
  chunkBytes = DEFAULT_CHUNK_BYTES,
  readBudgetBytes = MSE_SEEK_READ_BUDGET_BYTES,
  probePrerollSeconds = 2,
  onProgress = () => {},
}) {
  if (!source || typeof source.read !== 'function' || typeof source.size !== 'bigint') {
    throw new TypeError('A recorded source with bigint size and read(offset, length) is required.');
  }
  if (!durationUs || durationUs <= 0n) throw new TypeError('durationUs must be positive.');
  if (!demuxer || typeof demuxer.push !== 'function') throw new TypeError('A demuxer is required.');
  if (typeof headReady !== 'function') throw new TypeError('headReady must be a function.');

  const chunkSize = BigInt(chunkBytes);
  const budget = BigInt(readBudgetBytes);
  const sourceTargetUs = BigInt(presentationStartUs) + BigInt(targetUs);
  const sourceEndUs = BigInt(presentationEndUs);
  const toleranceUs = BigInt(Math.round(ENTRY_TOLERANCE_SECONDS * 1000000));
  const tracks = new Map();
  const cachedRanges = [];
  const probeFrontiers = new Map();
  const probeRaps = new Map();
  const timelineSamples = [];
  let phase = 'idle';
  let bytesRead = 0n;
  let currentPushOffset = 0n;

  const active = () => !signal?.aborted && isActive();
  const ensureActive = () => { if (!active()) throw abortError(); };
  const candidates = () => [...tracks.values()].filter(candidateVideoTrack);

  const observeTrack = track => tracks.set(track.trackId, track);
  const observeTrackRemoved = track => tracks.delete(track.trackId);
  const observeAccessUnit = unit => {
    if ((phase !== 'head' && phase !== 'probe') || unit.codec !== 'hevc') return;
    const track = tracks.get(unit.trackId);
    if (!track || !candidateVideoTrack(track)) return;
    const pts = timestampUs(unit);
    if (pts === null) return;
    timelineSamples.push({
      ptsUs: pts,
      offset: unit.inputOffset === undefined ? currentPushOffset : BigInt(unit.inputOffset),
    });
    if (timelineSamples.length > 512) timelineSamples.splice(0, timelineSamples.length - 512);
    if (phase !== 'probe') return;
    const previousFrontier = probeFrontiers.get(unit.trackId);
    if (previousFrontier === undefined || pts > previousFrontier) probeFrontiers.set(unit.trackId, pts);
    if (!unit.randomAccess || pts > sourceTargetUs + toleranceUs) return;
    const previous = probeRaps.get(unit.trackId);
    if (!previous || pts > previous.ptsUs) {
      probeRaps.set(unit.trackId, {
        trackId: unit.trackId,
        ptsUs: pts,
        seconds: Number(unit.ptsValue) / unit.ptsTimescale,
        restartOffset: BigInt(unit.restartOffset),
      });
    }
  };

  const cachedAt = offset => cachedRanges.find(item => item.start <= offset && item.end > offset);
  const nextCachedStart = offset => cachedRanges.reduce(
    (next, item) => item.start > offset && (next === null || item.start < next) ? item.start : next,
    null,
  );
  const read = async (offset, wanted) => {
    ensureActive();
    const cached = cachedAt(offset);
    if (cached) {
      const available = cached.end - offset < wanted ? cached.end - offset : wanted;
      const start = Number(offset - cached.start);
      return cached.data.subarray(start, start + Number(available));
    }
    if (bytesRead >= budget) throw new MseRecordedSeekError('budget-exhausted');
    const remainingSource = source.size - offset;
    const remainingBudget = budget - bytesRead;
    let length = wanted < remainingSource ? wanted : remainingSource;
    if (length > remainingBudget) length = remainingBudget;
    const next = nextCachedStart(offset);
    if (next !== null && offset + length > next) length = next - offset;
    if (length <= 0n) throw new MseRecordedSeekError('budget-exhausted');
    const data = await source.read(offset, length);
    ensureActive();
    if (!(data instanceof Uint8Array)) throw new TypeError('source.read() must return Uint8Array.');
    if (!data.byteLength) throw new MseRecordedSeekError('source-ended');
    bytesRead += BigInt(data.byteLength);
    cachedRanges.push({start: offset, end: offset + BigInt(data.byteLength), data});
    cachedRanges.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
    onProgress({phase, bytesRead, budgetBytes: budget, offset});
    return data;
  };

  const push = async (data, offset) => {
    ensureActive();
    currentPushOffset = offset;
    const accepted = await demuxer.push(data);
    checkError();
    if (!accepted) {
      throw new MseRecordedSeekError('demux-failed', `The demuxer rejected input at byte ${offset}.`);
    }
  };

  const frontiersPastTarget = () => {
    const eligible = new Set(candidates().map(track => track.trackId));
    const observed = [...probeFrontiers].filter(([trackId]) => eligible.has(trackId));
    return observed.length > 0 && observed.every(([, frontier]) =>
      frontier > sourceTargetUs + toleranceUs);
  };

  const bestRap = () => [...probeRaps.values()]
    .filter(rap => rap.ptsUs <= sourceTargetUs && tracks.has(rap.trackId))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;

  const interpolatedTargetOffset = () => {
    const before = timelineSamples.filter(sample => sample.ptsUs <= sourceTargetUs)
      .sort((left, right) => left.ptsUs > right.ptsUs ? -1 : left.ptsUs < right.ptsUs ? 1 : 0)[0];
    const after = timelineSamples.filter(sample => sample.ptsUs > sourceTargetUs)
      .sort((left, right) => left.ptsUs < right.ptsUs ? -1 : left.ptsUs > right.ptsUs ? 1 : 0)[0];
    if (!before || !after || after.ptsUs === before.ptsUs || after.offset <= before.offset) return null;
    return before.offset + (after.offset - before.offset) * (sourceTargetUs - before.ptsUs) /
      (after.ptsUs - before.ptsUs);
  };

  const run = async () => {
    ensureActive();
    phase = 'head';
    await demuxer.setMseOutputEnabled(false);
    await demuxer.setMseTimestampOffset?.(-BigInt(presentationStartUs));
    let headOffset = 0n;
    while (!headReady()) {
      if (headOffset >= source.size) throw new MseRecordedSeekError('source-ended');
      const data = await read(headOffset, chunkSize);
      await push(data, headOffset);
      headOffset += BigInt(data.byteLength);
    }

    ensureActive();
    if (!await demuxer.setIndexDuration(sourceEndUs)) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer rejected the recording duration.');
    }
    const estimateValue = await demuxer.estimateOffset(sourceTargetUs, source.size);
    if (estimateValue === null || estimateValue === undefined) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer could not estimate the target byte position.');
    }
    const estimate = BigInt(estimateValue);
    const estimatedWindow = source.size * BigInt(Math.round(probePrerollSeconds * 1000000)) / durationUs;
    const window = clampBigInt(estimatedWindow, chunkSize, 4n * 1024n * 1024n);
    let lowerCandidate = 0n;
    let upperCandidate = estimate;
    let candidate = estimate > window ? estimate - window : 0n;
    let chosen = null;

    for (;;) {
      ensureActive();
      phase = 'probe';
      probeFrontiers.clear();
      probeRaps.clear();
      await demuxer.reposition(candidate, true);
      let offset = candidate;
      while (offset < source.size && !frontiersPastTarget()) {
        const data = await read(offset, chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
      }
      chosen = bestRap();
      if (chosen) break;
      if (candidate === 0n) throw new MseRecordedSeekError('no-rap');
      upperCandidate = candidate;
      const interpolated = interpolatedTargetOffset();
      const interpolatedCandidate = interpolated === null ? null
        : interpolated > window ? interpolated - window : 0n;
      const nextCandidate = interpolatedCandidate !== null && interpolatedCandidate < candidate
        ? interpolatedCandidate : (lowerCandidate + upperCandidate) / 2n;
      candidate = nextCandidate < candidate ? nextCandidate : 0n;
    }

    const chosenTrack = tracks.get(chosen.trackId);
    await activateVideoTrack(chosenTrack, chosen);
    ensureActive();
    phase = 'landing';
    let offset = chosen.restartOffset;
    await demuxer.reposition(offset, true);
    await beforeLanding(chosenTrack, chosen);
    await demuxer.setMseOutputEnabled(true);

    let pushedLandingInput = false;
    while (!pushedLandingInput || !flowControl.entryCovered()) {
      ensureActive();
      if (offset >= source.size) throw new MseRecordedSeekError('source-ended');
      const data = await read(offset, chunkSize);
      await push(data, offset);
      pushedLandingInput = true;
      offset += BigInt(data.byteLength);
      await waitForAppends();
      await flowControl.afterPush(data.byteLength, active);
    }
    phase = 'complete';
    return {
      targetUs,
      sourceTargetUs,
      estimateOffset: estimate,
      restartOffset: chosen.restartOffset,
      rapPresentationTimeUs: chosen.ptsUs,
      nextOffset: offset,
      bytesRead,
      budgetBytes: budget,
    };
  };

  return {
    run,
    observeTrack,
    observeTrackRemoved,
    observeAccessUnit,
    get phase() { return phase; },
    get bytesRead() { return bytesRead; },
    get budgetBytes() { return budget; },
  };
}
