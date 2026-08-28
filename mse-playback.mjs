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
  if (entryKind !== 'startup' && entryKind !== 'seek') {
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

  const classifyUncoveredEntry = () => {
    if (queues.size < 2) return null;
    const ranges = perTrackRanges();
    if (!ranges.every(items => items.length > 0)) return null;
    if (entryKind === 'startup') {
      return new MseStartupBufferError(
        'Audio and video were appended, but their common range does not cover timestamp 0.');
    }
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
      return coveringRange(queues, entryTimeSeconds, entryToleranceSeconds);
    },
    entryCovered() {
      return entryCovered || api.entryRange() !== null;
    },
    commonAhead() {
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
        if (entryKind === 'startup') startupBytes += byteLength;
        const error = classifyUncoveredEntry();
        if (error) throw error;
        if (entryKind === 'startup' && startupBytes >= startupNoProgressBytes) {
          throw new MseStartupBufferError(
            `${startupNoProgressBytes} bytes were read without forming a common A/V range at timestamp 0.`);
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
  source,
  durationUs,
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
    if (!unit.randomAccess || pts > targetUs + toleranceUs) return;
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
    return observed.length > 0 && observed.every(([, frontier]) => frontier > targetUs + toleranceUs);
  };

  const bestRap = () => [...probeRaps.values()]
    .filter(rap => rap.ptsUs <= targetUs && tracks.has(rap.trackId))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;

  const interpolatedTargetOffset = () => {
    const before = timelineSamples.filter(sample => sample.ptsUs <= targetUs)
      .sort((left, right) => left.ptsUs > right.ptsUs ? -1 : left.ptsUs < right.ptsUs ? 1 : 0)[0];
    const after = timelineSamples.filter(sample => sample.ptsUs > targetUs)
      .sort((left, right) => left.ptsUs < right.ptsUs ? -1 : left.ptsUs > right.ptsUs ? 1 : 0)[0];
    if (!before || !after || after.ptsUs === before.ptsUs || after.offset <= before.offset) return null;
    return before.offset + (after.offset - before.offset) * (targetUs - before.ptsUs) /
      (after.ptsUs - before.ptsUs);
  };

  const run = async () => {
    ensureActive();
    phase = 'head';
    await demuxer.setMseOutputEnabled(false);
    let headOffset = 0n;
    while (!headReady()) {
      if (headOffset >= source.size) throw new MseRecordedSeekError('source-ended');
      const data = await read(headOffset, chunkSize);
      await push(data, headOffset);
      headOffset += BigInt(data.byteLength);
    }

    ensureActive();
    if (!await demuxer.setIndexDuration(durationUs)) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer rejected the recording duration.');
    }
    const estimateValue = await demuxer.estimateOffset(targetUs, source.size);
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
