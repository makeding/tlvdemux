import {ENTRY_TOLERANCE_SECONDS} from './mse-playback-buffer.mjs';
import {MSE_SEEK_READ_BUDGET_BYTES, MseRecordedSeekError} from './mse-playback-contract.mjs';
import {createMsePlaybackFlowControl} from './mse-playback-flow-control.mjs';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_LANDING_RESERVE_BYTES = 4 * 1024 * 1024;

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
  landingReserveBytes = DEFAULT_LANDING_RESERVE_BYTES,
  probePrerollSeconds = 2,
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
  const landingReserve = BigInt(landingReserveBytes);
  if (chunkSize <= 0n || landingReserve < chunkSize || landingReserve >= budget) {
    throw new RangeError('The recorded seek landing reserve must fit inside the read budget.');
  }
  const sourceTargetUs = BigInt(presentationStartUs) + BigInt(targetUs);
  const sourceEndUs = BigInt(presentationEndUs);
  const toleranceUs = BigInt(Math.round(ENTRY_TOLERANCE_SECONDS * 1000000));
  const tracks = new Map();
  const cachedRanges = [];
  const plannedRaps = new Map();
  const planFrontiers = new Map();
  let anchorBefore = {ptsUs: BigInt(presentationStartUs), offset: 0n};
  let anchorAfter = null;
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
    if (phase === 'backward-plan') {
      const priorFrontier = planFrontiers.get(unit.trackId);
      if (priorFrontier === undefined || ptsUs > priorFrontier) planFrontiers.set(unit.trackId, ptsUs);
    }
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
    if (phase === 'backward-plan' && typeof demuxer.broadcastClock === 'function') {
      const clock = await demuxer.broadcastClock();
      if (clock?.mediaTimeValue !== undefined && clock.mediaTimeTimescale &&
          clock.inputOffset !== undefined) {
        const ptsUs = BigInt(clock.mediaTimeValue) * 1000000n /
          BigInt(clock.mediaTimeTimescale);
        const anchor = {ptsUs, offset: BigInt(clock.inputOffset)};
        if (ptsUs <= sourceTargetUs && ptsUs > anchorBefore.ptsUs) anchorBefore = anchor;
        if (ptsUs > sourceTargetUs && (!anchorAfter || ptsUs < anchorAfter.ptsUs)) {
          anchorAfter = anchor;
        }
      }
    }
  };
  const bestRap = ({allowBootstrap = false} = {}) => [...plannedRaps.values()]
    .filter(rap => rap.ptsUs <= sourceTargetUs && tracks.has(rap.trackId) &&
      (allowBootstrap || rap.discoveredDuring === 'backward-plan'))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;
  const planPastTarget = () => {
    const eligible = new Set(candidates().map(track => track.trackId));
    const observed = [...planFrontiers].filter(([trackId]) => eligible.has(trackId));
    return observed.length > 0 && observed.every(([, frontier]) => frontier > sourceTargetUs + toleranceUs);
  };
  const projectedTargetOffset = () => {
    if (!anchorAfter || anchorAfter.ptsUs <= anchorBefore.ptsUs ||
        anchorAfter.offset <= anchorBefore.offset) return null;
    return anchorBefore.offset + (anchorAfter.offset - anchorBefore.offset) *
      (sourceTargetUs - anchorBefore.ptsUs) / (anchorAfter.ptsUs - anchorBefore.ptsUs);
  };

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
    const presentationStartRap = bestRap({allowBootstrap: true});
    if (presentationStartRap && sourceTargetUs - presentationStartRap.ptsUs <= 2_000_000n) {
      return {chosen: presentationStartRap, estimate};
    }
    const estimatedWindow = source.size * 2_000_000n / BigInt(durationUs);
    const planStep = clampBigInt(estimatedWindow, chunkSize, 3n * chunkSize);
    const maximumCandidate = source.size > chunkSize ? source.size - chunkSize : 0n;
    let candidate = clampBigInt(estimate > planStep ? estimate - planStep : 0n, 0n, maximumCandidate);
    const visited = new Set();
    let backwardStride = planStep;
    while (bytesRead + chunkSize <= budget - landingReserve) {
      ensureActive();
      if (visited.has(candidate)) break;
      visited.add(candidate);
      planFrontiers.clear();
      await demuxer.reposition(candidate, true);
      // An estimate only chooses a sparse observation point. Empty media-free
      // windows do not earn a forward scan; the next bounded observation is
      // farther backward and the formal landing budget stays untouched.
      const remainingPlan = budget - landingReserve - bytesRead;
      const activeSpan = remainingPlan < chunkSize ? remainingPlan : chunkSize;
      const locateEnd = candidate + activeSpan < source.size ? candidate + activeSpan : source.size;
      let offset = candidate;
      while (offset < locateEnd && !planPastTarget()) {
        const data = await read(offset, locateEnd - offset < chunkSize ? locateEnd - offset : chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
        if (bestRap() && planPastTarget()) break;
      }
      const chosen = bestRap();
      if (chosen && planPastTarget()) return {chosen, estimate};
      if (candidate === 0n) break;
      const projected = projectedTargetOffset();
      const projectedCandidate = projected === null ? null : clampBigInt(
        projected > planStep ? projected - planStep : 0n, 0n, maximumCandidate,
      );
      if (projectedCandidate !== null && projectedCandidate < candidate &&
          !visited.has(projectedCandidate)) {
        candidate = projectedCandidate;
        backwardStride = planStep;
      } else {
        // Empty parser windows have no timestamp meaning. Move the *next
        // locate start* behind both this window and an exponentially growing
        // safety distance, never back toward the duration-linear estimate.
        const nextDistance = backwardStride + 8n * chunkSize;
        candidate = candidate > nextDistance ? candidate - nextDistance : 0n;
        backwardStride = backwardStride * 2n;
      }
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
        evidence.heldFrameTimeUs === undefined || evidence.recoveryTimeUs === undefined) {
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
