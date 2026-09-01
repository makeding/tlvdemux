import {ENTRY_TOLERANCE_SECONDS} from './mse-playback-buffer.mjs';
import {
  MSE_SEEK_MAX_READ_BUDGET_BYTES,
  MSE_SEEK_READ_BUDGET_BYTES,
  MseRecordedSeekError,
} from './mse-playback-contract.mjs';
import {createMsePlaybackFlowControl} from './mse-playback-flow-control.mjs';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_LANDING_RESERVE_BYTES = 7 * 1024 * 1024;
const DEFAULT_EVIDENCE_PLANNING_BYTES = 12 * 1024 * 1024;
const BUDGET_TIERS_BYTES = [32, 48, 64].map(value => value * 1024 * 1024);
const LONG_GOP_LOOKBACK_US = 5_000_000n;

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

function roundUp(value, alignment) {
  return (value + alignment - 1n) / alignment * alignment;
}

function roundDown(value, alignment) {
  return value / alignment * alignment;
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
    allowNaturalStart: BigInt(targetUs) === 0n,
  }),
  signal = null,
  isActive = () => true,
  headReady,
  initialTracks = [],
  timelineEstablished = false,
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
  maxReadBudgetBytes = MSE_SEEK_MAX_READ_BUDGET_BYTES,
  landingReserveBytes = DEFAULT_LANDING_RESERVE_BYTES,
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
    'flushMseRecordedSeekAudio', 'flushMseRecordedSeekLanding',
  ]) {
    if (typeof demuxer[method] !== 'function') {
      throw new TypeError(`The demuxer must support ${method}().`);
    }
  }
  if (typeof headReady !== 'function') throw new TypeError('headReady must be a function.');

  const chunkSize = BigInt(chunkBytes);
  const baseBudget = BigInt(readBudgetBytes);
  const maximumBudget = BigInt(maxReadBudgetBytes);
  const landingReserve = BigInt(landingReserveBytes);
  const basePlanningLimit = baseBudget - landingReserve;
  const evidencePlanningLimit = baseBudget - 4n * chunkSize;
  if (chunkSize <= 0n || landingReserve < chunkSize || landingReserve >= baseBudget) {
    throw new RangeError('The recorded seek landing reserve must fit inside the read budget.');
  }
  if (maximumBudget < baseBudget) {
    throw new RangeError('The recorded seek maximum budget must include the base budget.');
  }
  const sourceTargetUs = BigInt(presentationStartUs) + BigInt(targetUs);
  const sourceEndUs = BigInt(presentationEndUs);
  const toleranceUs = BigInt(Math.round(ENTRY_TOLERANCE_SECONDS * 1000000));
  const tracks = new Map();
  const cachedRanges = [];
  const plannedRaps = new Map();
  const futureRaps = new Map();
  const damageEpisodes = [];
  const planningTrace = [];
  let anchorBefore = {ptsUs: BigInt(presentationStartUs), offset: 0n};
  let anchorAfter = null;
  let anchorBeforeObserved = false;
  let timedObservationRevision = 0;
  let phase = 'idle';
  let bytesRead = 0n;
  let authorizedBudget = baseBudget;
  let budgetAuthorization = null;
  let planningRangeExtended = false;
  let currentPushOffset = 0n;
  let bootstrapTimelineReady = timelineEstablished;

  for (const track of initialTracks) tracks.set(track.trackId, track);

  const active = () => !signal?.aborted && isActive();
  const ensureActive = () => { if (!active()) throw abortError(); };
  const hasVideo = () => requiredTracks.includes('video');
  const planningLimit = () => planningRangeExtended
    ? (evidencePlanningLimit < BigInt(DEFAULT_EVIDENCE_PLANNING_BYTES)
      ? evidencePlanningLimit : BigInt(DEFAULT_EVIDENCE_PLANNING_BYTES))
    : basePlanningLimit;

  const observePlanningAnchor = anchor => {
    timedObservationRevision += 1;
    if (anchor.ptsUs <= sourceTargetUs && anchor.ptsUs > anchorBefore.ptsUs) {
      anchorBefore = anchor;
      anchorBeforeObserved = true;
    }
    if (anchor.ptsUs > sourceTargetUs &&
        (!anchorAfter || anchor.ptsUs < anchorAfter.ptsUs)) {
      anchorAfter = anchor;
    }
  };

  const observeTrack = track => tracks.set(track.trackId, track);
  const observeTrackRemoved = track => tracks.delete(track.trackId);
  const observeDamage = damage => {
    if (damage?.severity !== 'severe') return;
    const startUs = damage.startTimeUs ?? damage.endTimeUs;
    if (startUs === null || startUs === undefined) return;
    damageEpisodes.push({
      trackId: damage.videoTrackId,
      startUs: BigInt(startUs),
      endUs: damage.recoveryTimeUs === null || damage.recoveryTimeUs === undefined
        ? null : BigInt(damage.recoveryTimeUs),
    });
  };
  const observeAccessUnit = unit => {
    if (phase !== 'bootstrap' && phase !== 'backward-plan') return;
    const track = tracks.get(unit.trackId);
    if (!track) return;
    const ptsUs = timestampUs(unit);
    if (ptsUs === null) return;
    const unitInputOffset = unit.inputOffset ?? unit.restartOffset;
    if (phase === 'backward-plan' && track.kind === 'audio' && unit.codec === 'aac-latm' &&
        unitInputOffset !== undefined) {
      observePlanningAnchor({ptsUs, offset: BigInt(unitInputOffset)});
    }
    if (!candidateVideoTrack(track)) return;
    if (track.kind === 'video' && unit.codec !== 'hevc') return;
    if (track.kind === 'audio' && unit.codec !== 'aac-latm') return;
    if (track.kind === 'video' && unit.randomAccess) {
      const openEpisode = [...damageEpisodes].reverse().find(episode =>
        episode.trackId === unit.trackId && episode.endUs === null && episode.startUs < ptsUs);
      if (openEpisode) openEpisode.endUs = ptsUs;
    }
    if (phase === 'bootstrap') bootstrapTimelineReady = true;
    if (track.kind === 'video' && !unit.randomAccess) return;
    const rap = {
      trackId: unit.trackId,
      ptsUs,
      seconds: Number(unit.ptsValue) / unit.ptsTimescale,
      restartOffset: BigInt(unit.restartOffset),
      discoveredDuring: phase,
    };
    if (ptsUs > sourceTargetUs + toleranceUs) {
      futureRaps.set(`${unit.trackId}:${ptsUs}`, rap);
      return;
    }
    plannedRaps.set(`${unit.trackId}:${ptsUs}`, rap);
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
    if (bytesRead >= authorizedBudget) throw new MseRecordedSeekError('budget-exhausted');
    const remainingSource = source.size - offset;
    const remainingBudget = authorizedBudget - bytesRead;
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
    onProgress({phase, bytesRead, budgetBytes: authorizedBudget, offset});
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
        observePlanningAnchor({ptsUs, offset: BigInt(clock.inputOffset)});
      }
    }
  };
  const bestRap = ({allowBootstrap = false} = {}) => [...plannedRaps.values()]
    .filter(rap => rap.ptsUs <= sourceTargetUs && tracks.has(rap.trackId) &&
      !damageEpisodes.some(episode => episode.trackId === rap.trackId &&
        rap.ptsUs >= episode.startUs &&
        (episode.endUs === null || rap.ptsUs < episode.endUs)) &&
      (allowBootstrap || rap.discoveredDuring === 'backward-plan'))
    .sort((left, right) => {
      if (left.ptsUs !== right.ptsUs) return left.ptsUs > right.ptsUs ? -1 : 1;
      return videoTrackPriority(tracks.get(left.trackId)) - videoTrackPriority(tracks.get(right.trackId));
    })[0] ?? null;
  const closestFutureRap = () => [...futureRaps.values()]
    .filter(rap => tracks.has(rap.trackId) && rap.discoveredDuring === 'backward-plan')
    .sort((left, right) => left.ptsUs < right.ptsUs ? -1 : left.ptsUs > right.ptsUs ? 1 : 0)[0] ?? null;
  const projectedTargetOffset = () => {
    if (anchorBeforeObserved && anchorAfter && anchorAfter.ptsUs > anchorBefore.ptsUs &&
        anchorAfter.offset > anchorBefore.offset) {
      return anchorBefore.offset + (anchorAfter.offset - anchorBefore.offset) *
        (sourceTargetUs - anchorBefore.ptsUs) / (anchorAfter.ptsUs - anchorBefore.ptsUs);
    }
    return null;
  };
  const bytesForDuration = duration => {
    if (anchorBeforeObserved && anchorAfter && anchorAfter.ptsUs > anchorBefore.ptsUs &&
        anchorAfter.offset > anchorBefore.offset) {
      return (anchorAfter.offset - anchorBefore.offset) * duration /
        (anchorAfter.ptsUs - anchorBefore.ptsUs);
    }
    return source.size * duration / BigInt(durationUs);
  };
  const targetOffsetEstimate = async () => {
    const value = estimateOffset === null
      ? await demuxer.estimateOffset(sourceTargetUs, source.size)
      : await estimateOffset(sourceTargetUs, source.size);
    if (value === null || value === undefined) {
      throw new MseRecordedSeekError(
        'demux-failed', 'The demuxer could not estimate the target byte position.');
    }
    return BigInt(value);
  };
  const cachedBytesBetween = (start, end) => cachedRanges.reduce((total, item) => {
    const overlapStart = item.start > start ? item.start : start;
    const overlapEnd = item.end < end ? item.end : end;
    return overlapEnd > overlapStart ? total + overlapEnd - overlapStart : total;
  }, 0n);
  const tierFor = requiredBytes => {
    const tiers = BUDGET_TIERS_BYTES.map(BigInt).filter(value => value <= maximumBudget);
    return tiers.find(value => value >= requiredBytes) ?? null;
  };
  const authorizeLandingBudget = ({chosen, estimate}) => {
    if (budgetAuthorization !== null) {
      throw new Error('The recorded seek landing budget was authorized more than once.');
    }
    const targetOffset = BigInt(estimate);
    let provedEnd = chosen.restartOffset + chunkSize;
    if (targetOffset >= chosen.restartOffset) {
      provedEnd = roundUp(targetOffset + chunkSize, chunkSize);
    }
    if (provedEnd > source.size) provedEnd = source.size;
    const cachedBytes = cachedBytesBetween(chosen.restartOffset, provedEnd);
    const candidateBytes = roundUp(
      bytesRead + (provedEnd - chosen.restartOffset - cachedBytes), chunkSize);
    const authorizationThreshold = candidateBytes + landingReserve;
    const fittingTier = tierFor(authorizationThreshold);
    const selectedTier = authorizationThreshold <= baseBudget
      ? baseBudget : fittingTier ?? maximumBudget;
    authorizedBudget = selectedTier;
    budgetAuthorization = {
      extended: authorizedBudget > baseBudget,
      saturated: fittingTier === null && authorizationThreshold > baseBudget,
      baseBudgetBytes: baseBudget, maximumBudgetBytes: maximumBudget,
      requiredBudgetBytes: candidateBytes, authorizationThresholdBytes: authorizationThreshold,
      authorizedBudgetBytes: authorizedBudget,
      provedEndOffset: provedEnd,
    };
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
    if (timelineEstablished && typeof demuxer.previousSync === 'function') {
      const indexed = await demuxer.previousSync(sourceTargetUs);
      if (indexed) {
        const chosen = {
          trackId: indexed.videoTrackId,
          ptsUs: BigInt(indexed.presentationTimeUs),
          seconds: Number(indexed.presentationTimeUs) / 1000000,
          restartOffset: BigInt(indexed.signallingOffset ?? indexed.randomAccessOffset),
          discoveredDuring: 'index',
        };
        if (chosen.ptsUs <= sourceTargetUs &&
            sourceTargetUs - chosen.ptsUs <= 2_000_000n &&
            tracks.has(chosen.trackId) && !damageEpisodes.some(episode =>
          episode.trackId === chosen.trackId && chosen.ptsUs >= episode.startUs &&
          (episode.endUs === null || chosen.ptsUs < episode.endUs))) {
          return {chosen, estimate: await targetOffsetEstimate()};
        }
      }
    }
    const estimate = await targetOffsetEstimate();
    const presentationStartRap = bestRap({allowBootstrap: true});
    if (presentationStartRap && BigInt(targetUs) === 0n) {
      return {chosen: presentationStartRap, estimate};
    }
    const maximumCandidate = source.size > chunkSize ? source.size - chunkSize : 0n;
    const alignCandidate = value => clampBigInt(roundDown(value, chunkSize), 0n, maximumCandidate);
    const estimatedTwoSecondBytes = bytesForDuration(2_000_000n);
    const initialDistance = basePlanningLimit - bytesRead + estimatedTwoSecondBytes;
    // First perform a coarse seek in a conservative pre-target Range. Keeping
    // that observation on the landing side of the target lets the formal
    // RAP-to-target pass reuse it instead of paying for an isolated future
    // Range that cannot contribute to continuous decode.
    // Once it exposes an AAC or broadcast-clock timestamp, use that evidence
    // to project a preceding long-GOP candidate. The candidate's file range is
    // then expanded contiguously, one chunk at a time, instead of spending the
    // plan on unrelated sparse windows or a resolution-specific allowance.
    let candidate = alignCandidate(estimate > initialDistance ? estimate - initialDistance : 0n);
    const visited = new Set();
    let fallbackStride = 8n * chunkSize;
    const evidenceCandidate = () => {
      const projected = projectedTargetOffset();
      if (projected !== null) {
        // Leave a two-chunk guard before the projected GOP boundary. Sparse
        // signalling commonly exposes its timestamp after the actual RAP
        // byte, so starting exactly at the projection can skip the RAP and
        // waste the remaining plan expanding on its later side.
        const lookbackBytes = bytesForDuration(LONG_GOP_LOOKBACK_US) + 7n * chunkSize;
        return alignCandidate(projected > lookbackBytes ? projected - lookbackBytes : 0n);
      }
      const futureRap = closestFutureRap();
      if (futureRap) {
        const lookbackUs = futureRap.ptsUs - sourceTargetUs + LONG_GOP_LOOKBACK_US;
        const lookbackBytes = bytesForDuration(lookbackUs) + 7n * chunkSize;
        return alignCandidate(futureRap.restartOffset > lookbackBytes
          ? futureRap.restartOffset - lookbackBytes : 0n);
      }
      // A lone pre-target anchor proves that this Range is on the legal side
      // of the target, but it cannot prove a better byte position. Keep
      // extending this Range until it exposes a RAP; applying the global
      // bitrate as though it were a local pair can jump across the useful GOP.
      return null;
    };
    while (bytesRead + chunkSize <= planningLimit()) {
      ensureActive();
      if (visited.has(candidate)) break;
      visited.add(candidate);
      await demuxer.reposition(candidate, true);
      let offset = candidate;
      let nextCandidate = null;
      let windowHasTimedEvidence = false;
      while (offset < source.size && bytesRead + chunkSize <= planningLimit()) {
        const observationBefore = timedObservationRevision;
        const data = await read(offset, chunkSize);
        await push(data, offset);
        offset += BigInt(data.byteLength);
        const chosen = bestRap();
        if (chosen) return {chosen, estimate};
        windowHasTimedEvidence ||= timedObservationRevision > observationBefore;

        const refined = evidenceCandidate();
        if (refined !== null && planningLimit() < evidencePlanningLimit) {
          planningRangeExtended = true;
        }
        if (planningTrace.length < 32) planningTrace.push({
          candidate, offset, refined, windowHasTimedEvidence,
          beforePtsUs: anchorBefore.ptsUs, beforeOffset: anchorBefore.offset,
          afterPtsUs: anchorAfter?.ptsUs ?? null, afterOffset: anchorAfter?.offset ?? null,
        });
        const refinedOutsideWindow = refined !== null &&
          (refined + chunkSize < candidate || refined >= offset);
        const refinementDistance = refined === null ? 0n
          : refined < candidate ? candidate - refined : refined - candidate;
        // A local refinement within a few chunks is less valuable than
        // continuing the parser's current contiguous Range: the RAP may be in
        // bytes already supplied but not exposed until the following chunk.
        const refinementNeedsReposition = refinementDistance > 4n * chunkSize;
        if (windowHasTimedEvidence && refinedOutsideWindow && refinementNeedsReposition &&
            !visited.has(refined)) {
          nextCandidate = refined;
          break;
        }
        if (!windowHasTimedEvidence) break;
      }
      if (nextCandidate !== null) {
        candidate = nextCandidate;
        fallbackStride = 8n * chunkSize;
        continue;
      }
      if (windowHasTimedEvidence || candidate === 0n) break;
      candidate = candidate > fallbackStride ? candidate - fallbackStride : 0n;
      fallbackStride *= 2n;
    }
    const chosen = bestRap({allowBootstrap: true});
    if (chosen) return {chosen, estimate};
    throw new MseRecordedSeekError('no-rap');
  };

  const landingMode = () => {
    return flowControl.landingMode?.() ?? (flowControl.entryCovered() ? 'exact' : null);
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
    return hasNativeHeldFrameEvidence(evidence);
  };
  const singleLanding = async ({chosen, estimate}) => {
    authorizeLandingBudget({chosen, estimate});
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
        if (offset >= source.size) throw new MseRecordedSeekError('source-ended');
        const data = await read(offset, chunkSize);
        await push(data, offset);
        if (requiredTracks.includes('audio')) {
          await demuxer.flushMseRecordedSeekAudio();
        }
        offset += BigInt(data.byteLength);
        await waitForAppends();
        await flowControl.afterPush(data.byteLength, active);
        mode = landingMode();
        evidence = await nativeLandingEvidence();
        if (heldFrameEvidence(evidence)) mode = 'held-frame';
        if (mode) break;
        // The coarse target Range belongs to the same transaction. Reaching
        // the source-read ceiling does not exhaust already cached bytes: let
        // the landing bridge into that Range before deciding it needs another
        // source read. This is what makes locate-then-expand useful for a GOP
        // whose continuous landing span reaches the coarse observation.
        if (cachedAt(offset)) continue;
        if (bytesRead < authorizedBudget) continue;
        if (!sealed) {
          sealed = true;
          await demuxer.flushMseRecordedSeekLanding();
          await waitForAppends();
          await flowControl.afterPush(0, active);
          mode = landingMode();
          evidence = await nativeLandingEvidence();
          if (heldFrameEvidence(evidence)) mode = 'held-frame';
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
      nextOffset: offset, bytesRead, budgetBytes: authorizedBudget,
      baseBudgetBytes: baseBudget, maximumBudgetBytes: maximumBudget,
      budgetAuthorization, landingMode: mode,
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
          bytesRead: bytesRead.toString(), budgetBytes: authorizedBudget.toString(),
          baseBudgetBytes: baseBudget.toString(),
          maximumBudgetBytes: maximumBudget.toString(),
          planningRangeExtended,
          budgetAuthorization: budgetAuthorization === null ? null : Object.fromEntries(
            Object.entries(budgetAuthorization).map(([key, value]) => [
              key, typeof value === 'bigint' ? value.toString() : value,
            ]),
          ),
          planningAnchors: {
            before: {ptsUs: anchorBefore.ptsUs.toString(), offset: anchorBefore.offset.toString()},
            after: anchorAfter === null ? null : {
              ptsUs: anchorAfter.ptsUs.toString(), offset: anchorAfter.offset.toString(),
            },
          },
          planningTrace: planningTrace.map(item => Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key, typeof value === 'bigint' ? value.toString() : value,
            ]),
          )),
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
    run, observeTrack, observeTrackRemoved, observeAccessUnit, observeDamage,
    get phase() { return phase; },
    get bytesRead() { return bytesRead; },
    get budgetBytes() { return authorizedBudget; },
    get baseBudgetBytes() { return baseBudget; },
    get maximumBudgetBytes() { return maximumBudget; },
  };
}
