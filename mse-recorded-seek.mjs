import {ENTRY_TOLERANCE_SECONDS} from './mse-playback-buffer.mjs';
import {MSE_SEEK_READ_BUDGET_BYTES, MseRecordedSeekError} from './mse-playback-contract.mjs';
import {createMsePlaybackFlowControl} from './mse-playback-flow-control.mjs';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const PLANNER_WINDOW_BYTES = 6n * 1024n * 1024n;
const NEAR_ESTIMATE_PREROLL_BYTES = 10n * 1024n * 1024n;
const NEAR_ESTIMATE_WINDOW_BYTES = 7n * 1024n * 1024n;
const INITIAL_PLANNER_PREROLL_BYTES = 16n * 1024n * 1024n;
const MAX_PLANNER_WINDOWS = 2;

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

/**
 * Explicit recorded seeks have three data phases.  `backward-plan` may reset
 * the parser to inspect bounded byte windows, but only `single-landing` is a
 * formal playback landing: it has exactly one reposition and never changes
 * the requested media clock.
 */
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
  requiredTracks = ['video', 'audio'],
  flowControl = createMsePlaybackFlowControl({
    media, queues, requiredTracks, entryKind: 'seek',
    entryTimeSeconds: Number(targetUs) / 1000000,
  }),
  signal = null,
  isActive = () => true,
  headReady,
  candidateTrack = null,
  candidateVideoTrack = candidateTrack ?? (requiredTracks.length === 1 && requiredTracks[0] === 'audio'
    ? track => track.kind === 'audio'
    : track => track.kind === 'video'),
  trackPriority = null,
  videoTrackPriority = trackPriority ?? (() => 0),
  activateTrack = null,
  activateVideoTrack = activateTrack ?? (async () => {}),
  beforeLanding = async () => {},
  estimateOffset = null,
  waitForAppends = async () => {
    await Promise.all([...queues.values()].map(queue => queue.waitStable?.() ?? Promise.resolve()));
  },
  checkError = () => {},
  chunkBytes = DEFAULT_CHUNK_BYTES,
  readBudgetBytes = MSE_SEEK_READ_BUDGET_BYTES,
  onProgress = () => {},
}) {
  if (!source || typeof source.read !== 'function' || typeof source.size !== 'bigint') {
    throw new TypeError('A recorded source with bigint size and read(offset, length) is required.');
  }
  if (!durationUs || durationUs <= 0n) throw new TypeError('durationUs must be positive.');
  if (!demuxer || typeof demuxer.push !== 'function') throw new TypeError('A demuxer is required.');
  if (typeof demuxer.setMseRecordedSeekConcealmentTarget !== 'function') {
    throw new TypeError('The demuxer must support recorded-seek concealment targets.');
  }
  for (const method of [
    'beginMseRecordedSeek', 'finishMseRecordedSeek', 'cancelMseRecordedSeek',
    'flushMseRecordedSeekLanding',
  ]) {
    if (typeof demuxer[method] !== 'function') {
      throw new TypeError(`The demuxer must support ${method}().`);
    }
  }
  if (typeof headReady !== 'function') throw new TypeError('headReady must be a function.');

  const chunkSize = BigInt(chunkBytes);
  const budget = BigInt(readBudgetBytes);
  if (chunkSize <= 0n) throw new RangeError('The recorded seek chunk size must be positive.');
  const sourceTargetUs = BigInt(presentationStartUs) + BigInt(targetUs);
  const sourceEndUs = BigInt(presentationEndUs);
  const toleranceUs = BigInt(Math.round(ENTRY_TOLERANCE_SECONDS * 1000000));
  const tracks = new Map();
  const cachedRanges = [];
  const plannedRaps = new Map();
  let phase = 'idle';
  let bytesRead = 0n;
  let currentPushOffset = 0n;
  let bootstrapTimelineReady = false;

  const active = () => !signal?.aborted && isActive();
  const ensureActive = () => { if (!active()) throw abortError(); };
  const candidates = () => [...tracks.values()].filter(candidateVideoTrack);
  const hasVideo = () => requiredTracks.includes('video');

  const observeTrack = track => tracks.set(track.trackId, track);
  const observeTrackRemoved = track => tracks.delete(track.trackId);
  const observeAccessUnit = unit => {
    if (phase !== 'bootstrap' && phase !== 'backward-plan') return;
    const track = tracks.get(unit.trackId);
    if (!track || !candidateVideoTrack(track)) return;
    if (track.kind === 'video' && unit.codec !== 'hevc') return;
    if (track.kind === 'audio' && unit.codec !== 'aac-latm') return;
    const ptsUs = timestampUs(unit);
    if (ptsUs === null) return;
    if (phase === 'bootstrap') bootstrapTimelineReady = true;
    if ((track.kind === 'video' && !unit.randomAccess) || ptsUs > sourceTargetUs + toleranceUs) return;
    plannedRaps.set(`${unit.trackId}:${ptsUs}`, {
      trackId: unit.trackId,
      ptsUs,
      seconds: Number(unit.ptsValue) / unit.ptsTimescale,
      restartOffset: BigInt(unit.restartOffset),
      discoveredDuring: phase,
    });
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
  const bestRap = ({allowBootstrap = false} = {}) => [...plannedRaps.values()]
    .filter(rap => rap.ptsUs <= sourceTargetUs && tracks.has(rap.trackId) &&
      (allowBootstrap || rap.discoveredDuring === 'backward-plan'))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;
  const bootstrap = async () => {
    phase = 'bootstrap';
    await demuxer.setMseOutputEnabled(false);
    await demuxer.setMseTimestampOffset?.(-BigInt(presentationStartUs));
    let offset = 0n;
    while (!headReady() || !bootstrapTimelineReady) {
      if (offset >= source.size) throw new MseRecordedSeekError('source-ended');
      const data = await read(offset, chunkSize);
      await push(data, offset);
      offset += BigInt(data.byteLength);
    }
    if (!await demuxer.setIndexDuration(sourceEndUs)) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer rejected the recording duration.');
    }
  };

  const backwardPlan = async () => {
    phase = 'backward-plan';
    const estimateValue = estimateOffset === null
      ? await demuxer.estimateOffset(sourceTargetUs, source.size)
      : await estimateOffset(sourceTargetUs, source.size);
    if (estimateValue === null || estimateValue === undefined) {
      throw new MseRecordedSeekError('demux-failed', 'The demuxer could not estimate the target byte position.');
    }
    const estimate = BigInt(estimateValue);
    // A retained RecordingIndex is stronger than a duration-linear byte
    // estimate. It already names the preceding decodable restart boundary, so
    // use it directly instead of trying to rediscover a RAP from raw sparse
    // packets. Worker adapters may omit this optional direct-WASM fast path.
    if (typeof demuxer.previousSync === 'function') {
      const indexed = await demuxer.previousSync(sourceTargetUs);
      if (indexed?.presentationTimeUs !== undefined &&
          indexed?.signallingOffset !== undefined &&
          BigInt(indexed.presentationTimeUs) <= sourceTargetUs &&
          sourceTargetUs - BigInt(indexed.presentationTimeUs) <= 2_000_000n &&
          tracks.has(indexed.videoTrackId)) {
        return {
          chosen: {
            trackId: indexed.videoTrackId,
            ptsUs: BigInt(indexed.presentationTimeUs),
            seconds: Number(indexed.presentationTimeUs) / 1000000,
            restartOffset: BigInt(indexed.signallingOffset),
            discoveredDuring: 'recording-index',
          },
          estimate,
        };
      }
    }
    const presentationStartRap = bestRap({allowBootstrap: true});
    if (presentationStartRap && sourceTargetUs - presentationStartRap.ptsUs <= 2_000_000n) {
      return {chosen: presentationStartRap, estimate};
    }
    const maximumCandidate = source.size > chunkSize ? source.size - chunkSize : 0n;
    const nearEstimateCandidate = clampBigInt(estimate > NEAR_ESTIMATE_PREROLL_BYTES
      ? estimate - NEAR_ESTIMATE_PREROLL_BYTES : 0n, 0n, maximumCandidate);
    const conservativeCandidate = clampBigInt(estimate > INITIAL_PLANNER_PREROLL_BYTES
      ? estimate - INITIAL_PLANNER_PREROLL_BYTES : 0n, 0n, maximumCandidate);
    const windows = [
      {candidate: nearEstimateCandidate, span: NEAR_ESTIMATE_WINDOW_BYTES},
      {candidate: conservativeCandidate, span: PLANNER_WINDOW_BYTES},
    ].filter((window, index, all) =>
      index === 0 || !all.slice(0, index).some(previous => previous.candidate === window.candidate));
    for (const {candidate, span} of windows.slice(0, MAX_PLANNER_WINDOWS)) {
      ensureActive();
      await demuxer.reposition(candidate, true);
      const remainingPlan = budget - bytesRead;
      const activeSpan = remainingPlan < span ? remainingPlan : span;
      const locateEnd = candidate + activeSpan < source.size ? candidate + activeSpan : source.size;
      let offset = candidate;
      while (offset < locateEnd && !bestRap()) {
        const data = await read(offset, locateEnd - offset < chunkSize ? locateEnd - offset : chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
      }
      const chosen = bestRap();
      if (chosen) return {chosen, estimate};
    }
    const chosen = bestRap();
    if (chosen) return {chosen, estimate};
    throw new MseRecordedSeekError('no-rap');
  };

  const landingMode = () => {
    if (flowControl.entryCovered()) return 'exact';
    return null;
  };
  const nativeLandingEvidence = async () => {
    if (typeof demuxer.getMseRecordedSeekLandingEvidence !== 'function') return null;
    return await demuxer.getMseRecordedSeekLandingEvidence();
  };
  const hasNativeHeldFrameEvidence = evidence => {
    if (evidence?.landingMode !== 'held-frame' ||
        evidence.heldFrameTimeUs == null || evidence.recoveryTimeUs == null) {
      return false;
    }
    const heldFrameTimeUs = BigInt(evidence.heldFrameTimeUs);
    const recoveryTimeUs = BigInt(evidence.recoveryTimeUs);
    return heldFrameTimeUs <= sourceTargetUs && recoveryTimeUs > sourceTargetUs;
  };
  const heldFrameEvidence = evidence => {
    if (!hasVideo() || flowControl.heldFrameEntryRange?.() === null) return false;
    // A short AAC tail behind an already committed native video frame is the
    // normal-playback case: audio resumes when the following AAC arrives.  A
    // true video hole additionally needs the remuxer's stable-RAP evidence.
    // The exact-video/natural-AAC-tail case is already visible in committed
    // coded ranges. A genuine held video frame is allowed only with the
    // remuxer's pre-target-frame and stable-following-RAP proof.
    return evidence?.landingMode !== 'held-frame' || hasNativeHeldFrameEvidence(evidence);
  };
  const singleLanding = async ({chosen, estimate}) => {
    const chosenTrack = tracks.get(chosen.trackId);
    await activateVideoTrack(chosenTrack, chosen);
    ensureActive();
    phase = 'single-landing';
    let offset = chosen.restartOffset;
    await demuxer.reposition(offset, true);
    await beforeLanding(chosenTrack, chosen);
    await demuxer.setMseOutputEnabled(true);
    await demuxer.setMseRecordedSeekConcealmentTarget(hasVideo() ? sourceTargetUs : null);
    let sealed = false;
    let mode = null;
    let evidence = null;
    try {
      for (;;) {
        ensureActive();
        const data = await read(offset, chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
        await waitForAppends();
        await flowControl.afterPush(data.byteLength, active);
        mode = landingMode();
        evidence = await nativeLandingEvidence();
        if (!mode && heldFrameEvidence(evidence)) mode = 'held-frame';
        if (mode) break;
        if (bytesRead < budget) continue;
        if (!sealed) {
          sealed = true;
          await demuxer.flushMseRecordedSeekLanding();
          await waitForAppends();
          await flowControl.afterPush(0, active);
          mode = landingMode();
          evidence = await nativeLandingEvidence();
          if (!mode && heldFrameEvidence(evidence)) mode = 'held-frame';
          if (mode) break;
        }
        throw new MseRecordedSeekError('budget-exhausted');
      }
    } finally {
      if (hasVideo()) await demuxer.setMseRecordedSeekConcealmentTarget(null);
    }
    return {
      targetUs, requestedTimeSeconds: Number(targetUs) / 1000000, sourceTargetUs, estimateOffset: estimate,
      restartOffset: chosen.restartOffset, rapPresentationTimeUs: chosen.ptsUs,
      nextOffset: offset, bytesRead, budgetBytes: budget, landingMode: mode,
      landingEvidence: evidence,
      heldFrameTimeSeconds: mode === 'held-frame' && hasNativeHeldFrameEvidence(evidence)
        ? Number(BigInt(evidence.heldFrameTimeUs) - BigInt(presentationStartUs)) / 1000000 : null,
      recoveryTimeSeconds: mode === 'held-frame' && hasNativeHeldFrameEvidence(evidence)
        ? Number(BigInt(evidence.recoveryTimeUs) - BigInt(presentationStartUs)) / 1000000 : null,
      heldFrameRange: mode === 'held-frame' ? flowControl.heldFrameEntryRange() : null,
    };
  };

  const run = async () => {
    ensureActive();
    await demuxer.beginMseRecordedSeek();
    try {
      await bootstrap();
      const plan = await backwardPlan();
      const result = await singleLanding(plan);
      ensureActive();
      phase = 'committing';
      await demuxer.finishMseRecordedSeek(BigInt(targetUs));
      phase = 'complete';
      return result;
    } catch (error) {
      const failedPhase = phase;
      let diagnostics = null;
      if (error instanceof Error && error.name !== 'AbortError') {
        diagnostics = {
          targetTimeSeconds: Number(targetUs) / 1000000,
          sourceTargetUs: sourceTargetUs.toString(), phase: failedPhase,
          entryCovered: flowControl.entryCovered(), entryRange: flowControl.entryRange(),
          heldFrameRange: flowControl.heldFrameEntryRange?.() ?? null,
          flowEntryTimeSeconds: flowControl.entryTimeSeconds,
          flowRequiredTracks: flowControl.requiredTracks,
          bytesRead: bytesRead.toString(), budgetBytes: budget.toString(),
          tracks: Object.fromEntries(requiredTracks.map(type => {
            const queue = queues.get(type);
            return [type, {
              committed: queue?.committedRanges?.() ?? [], buffered: queue?.bufferedRanges?.() ?? [],
            }];
          })),
        };
      }
      await demuxer.cancelMseRecordedSeek();
      phase = 'cancelled';
      if (diagnostics !== null) {
        error.diagnostics = diagnostics;
        error.message += ` Diagnostics: ${JSON.stringify(diagnostics)}`;
      }
      throw error;
    }
  };

  return {
    run, observeTrack, observeTrackRemoved, observeAccessUnit,
    get phase() { return phase; },
    get bytesRead() { return bytesRead; },
    get budgetBytes() { return budget; },
  };
}
