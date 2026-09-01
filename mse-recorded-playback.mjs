import {commonBufferedAhead} from './mse-playback-buffer.mjs';
import {MseAppendQuotaError} from './mse-append-queue.mjs';

export const MSE_RECORDED_READ_BUDGET_BYTES = 16 * 1024 * 1024;
export const MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND = 'MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND';
export const MSE_RECORDED_VIDEO_NOT_FOUND = 'MSE_RECORDED_VIDEO_NOT_FOUND';
export const MSE_RECORDED_ATOMIC_COMMIT_FAILED = 'MSE_RECORDED_ATOMIC_COMMIT_FAILED';
export const MSE_RECORDED_SOURCE_FAILED = 'MSE_RECORDED_SOURCE_FAILED';

const STATES = new Set([
  'idle', 'locating-audio', 'resolving-video', 'committing',
  'running', 'ended', 'error',
]);
const VIDEO_MODES = new Set(['preferred', 'rainfall', 'frozen']);
const SEEK_STATES = new Set([
  'seek-audio-anchor', 'seek-preferred', 'seek-rainfall',
  'seek-prior-frame', 'seek-commit', 'seek-resume',
]);
const CONTINUITY_STATES = new Set([
  'normal', 'damage-sealed', 'fallback-pending', 'frozen',
  'preferred-candidate', 'restoring',
]);
// ISO BMFF timescale conversion can round the first mapped AAC sample up by a
// handful of microseconds.  Keep the formal MSE splice just inside the exact
// requested clock without changing MediaElement.currentTime.
const MSE_TIMESTAMP_ROUNDING_GUARD_US = 16n;

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and non-negative.`);
  return value;
}

function covers(window, audio) {
  return window.closed !== false &&
    window.startTimeSeconds <= audio.startTimeSeconds + 0.05 &&
    window.endTimeSeconds >= audio.endTimeSeconds - 0.000001;
}

export function resolveRecordedVideoWindow({audio, preferred = [], rainfall = [], frozen = []}) {
  if (!audio || !(audio.endTimeSeconds > audio.startTimeSeconds)) {
    throw new TypeError('A non-empty AAC window is required.');
  }
  const chooseCovering = candidates => candidates
    .filter(candidate => covers(candidate, audio))
    .sort((left, right) => right.startTimeSeconds - left.startTimeSeconds)[0] ?? null;
  const preferredVideo = chooseCovering(preferred);
  if (preferredVideo) return {mode: 'preferred', video: preferredVideo, audio};
  const rainfallVideo = chooseCovering(rainfall);
  if (rainfallVideo) return {mode: 'rainfall', video: rainfallVideo, audio};
  const previous = frozen
    .filter(candidate => candidate.closed !== false &&
      candidate.startTimeSeconds <= audio.startTimeSeconds + 0.000001)
    .sort((left, right) => right.startTimeSeconds - left.startTimeSeconds)[0] ?? null;
  return previous ? {mode: 'frozen', video: previous, audio} : null;
}

export class MseRecordedPlaybackError extends Error {
  constructor(code, message, diagnostics) {
    super(`${code}: ${message}`);
    this.name = 'MseRecordedPlaybackError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function unitTimeSeconds(unit) {
  if (unit?.ptsValue === undefined || !unit.ptsTimescale) return null;
  return Number(BigInt(unit.ptsValue) * 1000000n / BigInt(unit.ptsTimescale)) / 1000000;
}

export function createMseRecordedWindowLocator({
  source,
  demuxer,
  queues,
  presentationStartUs = 0n,
  presentationEndUs = null,
  selectedAudioTrack,
  preferredVideoTrack,
  rainfallVideoTrack = () => null,
  activateVideoTrack = async () => {},
  onProgress = () => {},
  chunkBytes = 512 * 1024,
  audioWindowSeconds = 0.02,
}) {
  const audioUnits = [];
  const videoRaps = [];
  let currentPushOffset = 0n;
  let currentProbeEpoch = 0;
  let lockedAudioTrack = null;
  let lockedPreferredVideoTrack = null;
  let lockedRainfallVideoTrack = null;
  const trackId = value => value === null || value === undefined
    ? null : BigInt(typeof value === 'object' ? value.trackId : value);
  const insert = (items, item) => {
    if (!items.some(existing => existing.trackId === item.trackId &&
        existing.startTimeSeconds === item.startTimeSeconds &&
        existing.inputOffset === item.inputOffset &&
        existing.probeEpoch === item.probeEpoch)) {
      items.push(item);
      items.sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);
    }
  };
  const observeAccessUnit = unit => {
    const seconds = unitTimeSeconds(unit);
    if (seconds === null) return;
    const id = BigInt(unit.trackId);
    const inputOffset = BigInt(unit.inputOffset ?? currentPushOffset);
    const restartOffset = BigInt(unit.restartOffset ?? inputOffset);
    const audioTrack = lockedAudioTrack ?? trackId(selectedAudioTrack());
    const preferredTrack = lockedPreferredVideoTrack ?? trackId(preferredVideoTrack());
    const rainfallTrack = lockedRainfallVideoTrack ?? trackId(rainfallVideoTrack());
    if (unit.codec === 'aac-latm' && id === audioTrack) {
      insert(audioUnits, {
        trackId: id, startTimeSeconds: seconds, inputOffset, restartOffset,
        probeEpoch: currentProbeEpoch,
      });
    } else if (unit.codec === 'hevc' && unit.randomAccess) {
      const preferred = id === preferredTrack;
      const rainfall = id === rainfallTrack;
      if (!preferred && !rainfall) return;
      insert(videoRaps, {
        trackId: id, startTimeSeconds: seconds, endTimeSeconds: Infinity,
        inputOffset, restartOffset, closed: true,
        strictClosed: unit.closedRandomAccess === true,
        probeEpoch: currentProbeEpoch,
        layer: preferred ? 'preferred' : 'rainfall',
      });
    }
  };
  const locate = async ({
    targetTimeSeconds, readBudgetBytes, signal, transition,
    seekTransition = () => {},
    waitForQueues = () => Promise.all([...queues.values()].map(queue =>
      queue.waitStable?.() ?? queue.waitIdle?.())),
  }) => {
    audioUnits.length = 0;
    videoRaps.length = 0;
    lockedAudioTrack = null;
    lockedPreferredVideoTrack = null;
    lockedRainfallVideoTrack = null;
    const sourceTargetSeconds = Number(presentationStartUs) / 1000000 + targetTimeSeconds;
    const budget = BigInt(readBudgetBytes);
    const chunk = BigInt(chunkBytes);
    let bytesRead = 0n;
    const cachedReads = [];
    const read = async offset => {
      if (signal.aborted) throw abortError();
      const cached = cachedReads
        .filter(entry => entry.start <= offset && offset < entry.end)
        .sort((left, right) => left.end > right.end ? -1 : 1)[0];
      if (cached) {
        const begin = Number(offset - cached.start);
        const available = cached.end - offset;
        const length = available < chunk ? available : chunk;
        return cached.data.subarray(begin, begin + Number(length));
      }
      const remaining = budget - bytesRead;
      if (remaining <= 0n) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
          'The AAC target window exceeded the 16 MiB transaction budget.', {});
      }
      const length = [chunk, remaining, source.size - offset].reduce(
        (minimum, value) => value < minimum ? value : minimum);
      if (length <= 0n) return null;
      const data = await source.read(offset, length);
      bytesRead += BigInt(data.byteLength);
      cachedReads.push({
        start: offset,
        end: offset + BigInt(data.byteLength),
        data,
      });
      onProgress({bytesRead, budgetBytes: budget, offset});
      return data;
    };
    const push = async (data, offset) => {
      currentPushOffset = offset;
      if (!await demuxer.push(data)) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_SOURCE_FAILED, `The demuxer rejected input at ${offset}.`, {});
      }
    };
    const audioWindow = () => {
      const selected = audioUnits.filter(unit => unit.trackId === lockedAudioTrack &&
        unit.probeEpoch === currentProbeEpoch);
      const first = [...selected].reverse().find(unit =>
        unit.startTimeSeconds <= sourceTargetSeconds + 0.000001) ??
        [...selected].sort((left, right) =>
          Math.abs(left.startTimeSeconds - sourceTargetSeconds) -
          Math.abs(right.startTimeSeconds - sourceTargetSeconds))[0];
      if (!first || Math.abs(sourceTargetSeconds - first.startTimeSeconds) > 0.1) return null;
      const second = selected.find(unit => unit.startTimeSeconds >=
        Math.max(sourceTargetSeconds, first.startTimeSeconds) + audioWindowSeconds);
      const endTimeSeconds = second && second.startTimeSeconds - first.startTimeSeconds <= 0.1
        ? second.startTimeSeconds : first.startTimeSeconds + audioWindowSeconds;
      return {
        startTimeSeconds: first.startTimeSeconds,
        endTimeSeconds,
        inputOffset: first.inputOffset,
        restartOffset: first.restartOffset,
      };
    };
    const resolve = audio => {
      const closeGops = layer => videoRaps.filter(rap => rap.layer === layer).map(rap => {
        const next = videoRaps.find(candidate => candidate.trackId === rap.trackId &&
          candidate.probeEpoch === rap.probeEpoch &&
          candidate.startTimeSeconds > rap.startTimeSeconds);
        return {...rap, endTimeSeconds: next?.startTimeSeconds ?? rap.startTimeSeconds + 2};
      });
      return resolveRecordedVideoWindow({
        audio,
        preferred: closeGops('preferred'),
        rainfall: closeGops('rainfall'),
        frozen: videoRaps,
      });
    };
    const repositionWithLockedTracks = async offset => {
      currentProbeEpoch += 1;
      await demuxer.reposition(offset, true);
      // A byte reposition rebuilds the parser's transient track catalogue and
      // emits onTrackRemoved.  The recorded transaction, however, owns a
      // stable AAC/video selection.  Re-assert those locked identities before
      // any bytes at the new position are parsed so neither the probe nor the
      // landing can silently become audio-less.
      if (lockedAudioTrack !== null) {
        await demuxer.selectTrack?.('audio', lockedAudioTrack);
      }
      if (lockedPreferredVideoTrack !== null) {
        await demuxer.selectTrack?.('video', lockedPreferredVideoTrack);
      }
    };

    seekTransition('seek-audio-anchor');
    transition('locating-audio');
    await demuxer.setMseOutputEnabled(false);
    await demuxer.clearLastClosedVideoPicture?.();
    let headOffset = 0n;
    const headAudioReady = () => {
      const selected = trackId(selectedAudioTrack());
      const units = audioUnits.filter(unit => unit.trackId === selected);
      return units.length >= 2 &&
        units[units.length - 1].startTimeSeconds - units[0].startTimeSeconds >= 0.05;
    };
    while ((trackId(selectedAudioTrack()) === null ||
            trackId(preferredVideoTrack()) === null || !headAudioReady()) &&
           headOffset < source.size && bytesRead < budget) {
      const data = await read(headOffset);
      if (!data?.byteLength) break;
      await push(data, headOffset);
      headOffset += BigInt(data.byteLength);
    }
    lockedAudioTrack = trackId(selectedAudioTrack());
    lockedPreferredVideoTrack = trackId(preferredVideoTrack());
    lockedRainfallVideoTrack = trackId(rainfallVideoTrack());
    const targetUs = BigInt(Math.round(sourceTargetSeconds * 1000000));
    const headAudio = audioUnits.filter(unit => unit.trackId === lockedAudioTrack);
    const firstHeadAudio = headAudio[0];
    const lastHeadAudio = headAudio[headAudio.length - 1];
    let audioEstimate = null;
    if (firstHeadAudio && lastHeadAudio &&
        lastHeadAudio.startTimeSeconds > firstHeadAudio.startTimeSeconds + 0.05 &&
        lastHeadAudio.inputOffset > firstHeadAudio.inputOffset) {
      const bytesPerSecond = Number(lastHeadAudio.inputOffset - firstHeadAudio.inputOffset) /
        (lastHeadAudio.startTimeSeconds - firstHeadAudio.startTimeSeconds);
      const projected = Number(firstHeadAudio.inputOffset) +
        (sourceTargetSeconds - firstHeadAudio.startTimeSeconds) * bytesPerSecond;
      audioEstimate = BigInt(Math.max(0, Math.floor(projected)));
    }
    const videoEstimate = await demuxer.estimateOffset?.(targetUs, source.size) ?? null;
    const indexedAudioEstimate = await demuxer.estimateRecordedAudioOffset?.(
      targetUs, source.size) ?? null;
    // A few AAC frames from the file head describe local packet density, not
    // the recording's byte/time slope.  In particular, signalling bursts can
    // make that short extrapolation land hundreds of MiB before the target.
    // Prefer the duration-aware video index, then the sampled AAC index; the
    // short head extrapolation is only a last resort when neither index can
    // provide an estimate.
    let estimate = videoEstimate ?? indexedAudioEstimate ?? audioEstimate ?? 0n;
    const estimatedOffset = BigInt(estimate);
    const coarseBytesPerSecond = sourceTargetSeconds > 0
      ? Number(videoEstimate ?? estimatedOffset) / sourceTargetSeconds : 0;
    const probePrerollSeconds = Math.min(2, sourceTargetSeconds / 2);
    const measuredPreroll = BigInt(Math.ceil(
      coarseBytesPerSecond * probePrerollSeconds));
    const estimatePreroll = measuredPreroll > 8n * chunk
      ? measuredPreroll : 8n * chunk;
    estimate = estimatedOffset > estimatePreroll ? estimatedOffset - estimatePreroll : 0n;
    const endUs = presentationEndUs === null ? null : BigInt(presentationEndUs);
    if (BigInt(estimate) === 0n && endUs !== null && endUs > BigInt(presentationStartUs) &&
        targetUs > BigInt(presentationStartUs)) {
      const elapsed = targetUs - BigInt(presentationStartUs);
      const duration = endUs - BigInt(presentationStartUs);
      estimate = source.size * elapsed / duration;
    }
    let offset = BigInt(estimate);
    if (offset >= source.size) offset = source.size > chunk ? source.size - chunk : 0n;
    await repositionWithLockedTracks(offset);
    let probeBudgetStart = bytesRead;
    let refinements = 0;
    let audio = null;
    let choice = null;
    while (offset < source.size && bytesRead < budget && !audio) {
      const data = await read(offset);
      if (!data?.byteLength) break;
      await push(data, offset);
      offset += BigInt(data.byteLength);
      audio = audioWindow();
      if (audio) {
        transition('resolving-video');
        choice = resolve(audio);
      } else if (refinements < 4 && bytesRead - probeBudgetStart >= chunk) {
        // insert() keeps the global list sorted by presentation time, so a
        // length captured before reposition cannot delimit newly inserted
        // units: a backward refinement inserts before that old index.  Epoch
        // identity is the only reliable boundary between probe landings.
        const observed = audioUnits.filter(unit =>
          unit.trackId === lockedAudioTrack &&
          unit.probeEpoch === currentProbeEpoch);
        const first = observed[0];
        const last = observed[observed.length - 1];
        if (first && last &&
            (sourceTargetSeconds < first.startTimeSeconds - 0.1 ||
             sourceTargetSeconds > last.startTimeSeconds + 0.1)) {
          refinements += 1;
          const selectedObserved = audioUnits.filter(unit =>
            unit.trackId === lockedAudioTrack);
          const before = [...selectedObserved].reverse().find(unit =>
            unit.startTimeSeconds <= sourceTargetSeconds);
          const after = selectedObserved.find(unit =>
            unit.startTimeSeconds >= sourceTargetSeconds);
          let projected;
          if (before && after &&
              after.startTimeSeconds > before.startTimeSeconds + 0.02 &&
              after.inputOffset > before.inputOffset) {
            const ratio = (sourceTargetSeconds - before.startTimeSeconds) /
              (after.startTimeSeconds - before.startTimeSeconds);
            projected = Number(before.inputOffset) +
              Number(after.inputOffset - before.inputOffset) * ratio;
          } else {
            // AAC packet offsets inside one 512 KiB probe are bursty and are
            // not a stable bitrate estimate.  Use the nearest observation
            // with the duration-aware coarse slope until probes bracket the
            // target on both sides.
            const anchor = [first, last].sort((left, right) =>
              Math.abs(left.startTimeSeconds - sourceTargetSeconds) -
              Math.abs(right.startTimeSeconds - sourceTargetSeconds))[0];
            projected = Number(anchor.inputOffset) +
              (sourceTargetSeconds - anchor.startTimeSeconds) * coarseBytesPerSecond;
          }
          // Land before the projected AAC frame so signalling/bootstrap and
          // the complete target window are available in the same transaction.
          const backtrack = Number(8n * chunk);
          const bounded = Math.max(0, Math.min(Number(source.size - 1n), projected - backtrack));
          const refined = BigInt(Math.floor(bounded));
          if (refined + chunk < offset || refined > offset + chunk) {
            offset = refined;
            await repositionWithLockedTracks(offset);
            probeBudgetStart = bytesRead;
          }
        }
      }
    }
    if (!audio) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
        'No selected-AAC anchor window was found for the requested time.', {
          targetTimeSeconds,
          sourceTargetSeconds,
          lockedAudioTrack: lockedAudioTrack?.toString() ?? null,
          lockedPreferredVideoTrack: lockedPreferredVideoTrack?.toString() ?? null,
          lockedRainfallVideoTrack: lockedRainfallVideoTrack?.toString() ?? null,
          observedAudioUnits: audioUnits.length,
          observedAudioRange: audioUnits.length ? [
            audioUnits[0].startTimeSeconds,
            audioUnits[audioUnits.length - 1].startTimeSeconds,
          ] : null,
          observedVideoRaps: videoRaps.length,
          observedVideoRange: videoRaps.length ? [
            videoRaps[0].startTimeSeconds,
            videoRaps[videoRaps.length - 1].startTimeSeconds,
          ] : null,
          bytesRead: bytesRead.toString(),
          lastOffset: offset.toString(),
        });
    }
    seekTransition('seek-preferred');
    if (!choice && bytesRead < budget) {
      const futureRaps = videoRaps.filter(rap =>
        rap.trackId === lockedPreferredVideoTrack &&
        rap.startTimeSeconds > audio.startTimeSeconds)
        .filter((rap, index, values) => index === 0 ||
          rap.restartOffset !== values[index - 1].restartOffset)
        .sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);
      const measuredGopBytes = futureRaps.length >= 2 &&
        futureRaps[1].restartOffset > futureRaps[0].restartOffset
        ? futureRaps[1].restartOffset - futureRaps[0].restartOffset
        : null;
      const measuredBacktrack = measuredGopBytes === null
        ? BigInt(Math.ceil(coarseBytesPerSecond * 1.5))
        : measuredGopBytes * 2n / 3n;
      const referenceOffset = futureRaps[0]?.restartOffset ?? audio.restartOffset;
      const backtrack = measuredBacktrack > 16n * chunk
        ? measuredBacktrack : 16n * chunk;
      const safeBacktrack = backtrack + chunk;
      offset = referenceOffset > safeBacktrack ? referenceOffset - safeBacktrack : 0n;
      await repositionWithLockedTracks(offset);
      const videoProbeEnd = audio.inputOffset + 2n * chunk < source.size
        ? audio.inputOffset + 2n * chunk : source.size;
      while (!choice && offset < videoProbeEnd && bytesRead < budget) {
        const data = await read(offset);
        if (!data?.byteLength) break;
        await push(data, offset);
        offset += BigInt(data.byteLength);
        choice = resolve(audio);
      }
    }
    if (!choice) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_VIDEO_NOT_FOUND,
        'No preferred, rainfall, or prior closed video was found for the AAC window.', {
          targetTimeSeconds,
          audio,
          videoRaps: videoRaps.map(rap => ({
            trackId: rap.trackId.toString(),
            startTimeSeconds: rap.startTimeSeconds,
            closed: rap.closed,
            layer: rap.layer,
            inputOffset: rap.inputOffset.toString(),
          })),
          bytesRead: bytesRead.toString(),
        });
    }
    if (choice.mode !== 'preferred') seekTransition('seek-rainfall');
    if (choice.mode === 'frozen') seekTransition('seek-prior-frame');

    await activateVideoTrack(choice.mode, choice.video);
    seekTransition('seek-commit');
    // The video RAP can precede the AAC anchor by many MiB.  Start the formal
    // landing from the later restart point and repeat the already parsed
    // closed picture over the selected AAC window; re-reading the whole GOP
    // would spend the shared 16 MiB budget before the audio anchor arrives.
    const sourceGap = audio.restartOffset - BigInt(choice.video.restartOffset);
    const bridgePreferred = choice.mode !== 'frozen' && sourceGap > 8n * chunk &&
      choice.video.startTimeSeconds <= audio.startTimeSeconds;
    if (bridgePreferred) choice = {...choice, mode: 'frozen'};
    const landingOffset = choice.mode === 'frozen'
      ? (audio.restartOffset > chunk ? audio.restartOffset - chunk : 0n)
      : BigInt(choice.video.restartOffset);
    await repositionWithLockedTracks(landingOffset);
    const landingTimestampOffsetUs = targetTimeSeconds <= 0.000001
      ? -BigInt(presentationStartUs)
      : BigInt(Math.round(
        (targetTimeSeconds - audio.startTimeSeconds) * 1000000)) -
        MSE_TIMESTAMP_ROUNDING_GUARD_US;
    await demuxer.setMseTimestampOffset?.(landingTimestampOffsetUs);
    // Enabling output re-emits an already-discovered AAC init. Arm the formal
    // A/V splice first so neither cached init can escape ahead of its landing
    // boundary at the worker/output-pipeline edge.
    await demuxer.setMseOutputEnabled(true);
    if (choice.mode === 'frozen') {
      const repeated = await demuxer.repeatLastClosedVideoWindow(
        BigInt(Math.round(audio.startTimeSeconds * 1000000)),
        BigInt(Math.round(audio.endTimeSeconds * 1000000)));
      if (!repeated) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_VIDEO_NOT_FOUND,
          'The prior closed picture could not be repeated over the AAC window.', {});
      }
    }
    offset = landingOffset;
    const mediaTarget = targetTimeSeconds;
    const committed = () => {
      const ranges = [...queues.values()].map(queue => queue.committedRanges?.() ?? []);
      return ranges.length >= 2 && ranges.every(trackRanges => trackRanges.some(range =>
        range.start <= mediaTarget + 0.05 && range.end >= mediaTarget + 0.001));
    };
    while (!committed() && offset < source.size && bytesRead < budget) {
      const data = await read(offset);
      if (!data?.byteLength) break;
      await push(data, offset);
      offset += BigInt(data.byteLength);
      await waitForQueues();
    }
    if (!committed()) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_ATOMIC_COMMIT_FAILED,
        'The selected AAC window and resolved video did not commit atomically.', {
          targetTimeSeconds,
          sourceTargetSeconds,
          lockedAudioTrack: lockedAudioTrack?.toString() ?? null,
          lockedPreferredVideoTrack: lockedPreferredVideoTrack?.toString() ?? null,
          lockedRainfallVideoTrack: lockedRainfallVideoTrack?.toString() ?? null,
          audio: {
            ...audio,
            inputOffset: audio.inputOffset.toString(),
            restartOffset: audio.restartOffset.toString(),
          },
          video: {
            ...choice.video,
            trackId: choice.video.trackId.toString(),
            inputOffset: choice.video.inputOffset.toString(),
            restartOffset: choice.video.restartOffset.toString(),
          },
          videoMode: choice.mode,
          landingOffset: landingOffset.toString(),
          nextOffset: offset.toString(),
          bytesRead: bytesRead.toString(),
          committedRanges: Object.fromEntries([...queues].map(([type, queue]) =>
            [type, queue.committedRanges?.() ?? []])),
        });
    }
    return {nextOffset: offset, bytesRead, videoMode: choice.mode, audio, video: choice.video};
  };
  return {locate, observeAccessUnit};
}

export function createMseRecordedPlaybackController({
  source,
  demuxer,
  media,
  queues,
  initialOffset = 0n,
  highWallSeconds = 2,
  lowWallSeconds = 1,
  quotaStartWallSeconds = 0.5,
  readBudgetBytes = MSE_RECORDED_READ_BUDGET_BYTES,
  commonAhead = () => commonBufferedAhead(media, queues),
  locateSeekWindow,
  switchVideoMode = () => {},
  play = () => media.play?.(),
  onPlaybackStart = () => {},
  onStateChange = () => {},
  onProgress = () => {},
}) {
  if (!source?.stream || typeof source.read !== 'function') {
    throw new TypeError('Recorded playback requires source.stream() and source.read().');
  }
  if (!demuxer || typeof demuxer.push !== 'function') throw new TypeError('A demuxer is required.');
  if (!media || !queues || typeof queues.values !== 'function') {
    throw new TypeError('A MediaElement clock and A/V queues are required.');
  }
  if (typeof locateSeekWindow !== 'function') {
    throw new TypeError('Recorded playback requires an AAC-window locator.');
  }
  finiteNonNegative(highWallSeconds, 'highWallSeconds');
  finiteNonNegative(lowWallSeconds, 'lowWallSeconds');
  finiteNonNegative(quotaStartWallSeconds, 'quotaStartWallSeconds');
  if (!(highWallSeconds > lowWallSeconds)) throw new TypeError('highWallSeconds must exceed lowWallSeconds.');

  let state = 'idle';
  let seekState = null;
  let videoMode = 'preferred';
  let continuityState = 'normal';
  let fallbackReason = null;
  let damageStart = null;
  let aacFrontier = null;
  let frozenThrough = null;
  let candidateRap = null;
  let fallbackTrack = null;
  let lastVideoOutputEnd = null;
  let nextOffset = BigInt(initialOffset);
  let bytesRead = 0n;
  let intent = 0;
  let streamController = null;
  let feedPromise = null;
  let playbackRate = media.playbackRate > 0 ? media.playbackRate : 1;
  let presentedTime = null;
  let qualityFailures = 0;
  let playbackStarted = false;
  let quotaLimitedStartup = false;
  let progressWaiter = null;
  let lastProgress = null;
  let completion = null;
  let videoModeSwitch = Promise.resolve();
  const ensureCompletion = () => {
    if (!completion) {
      let resolve;
      let reject;
      const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      completion = {promise, resolve, reject};
    }
    return completion;
  };

  const snapshot = () => ({
    state, seekState, continuityState, videoMode, fallbackReason,
    damageStart, aacFrontier, frozenThrough, candidateRap, fallbackTrack,
    lastVideoOutputEnd, intent, nextOffset: nextOffset.toString(),
    bytesRead: bytesRead.toString(), playbackRate, presentedTime,
    playbackStarted, quotaLimitedStartup,
    commonAhead: commonAhead(), queueStates: Object.fromEntries([...queues].map(([type, queue]) => [type, {
      queuedBytes: queue.queuedBytes ?? null,
      currentBytes: queue.currentBytes ?? null,
      state: queue.state ?? null,
      quotaBlocked: queue.quotaBlocked ?? false,
      buffered: queue.bufferedRanges?.() ?? [],
      committed: queue.committedRanges?.() ?? [],
    }])),
    lastProgress,
  });
  const transition = next => {
    if (!STATES.has(next)) throw new TypeError(`Unknown Recorded state ${next}.`);
    if (state === next) return;
    state = next;
    onStateChange(snapshot());
  };
  const transitionSeek = next => {
    if (next !== null && !SEEK_STATES.has(next)) {
      throw new TypeError(`Unknown Recorded seek state ${next}.`);
    }
    seekState = next;
    onStateChange(snapshot());
  };
  const transitionContinuity = next => {
    if (!CONTINUITY_STATES.has(next)) {
      throw new TypeError(`Unknown Recorded continuity state ${next}.`);
    }
    continuityState = next;
    onStateChange(snapshot());
  };
  const setMode = (mode, reason) => {
    if (!VIDEO_MODES.has(mode)) throw new TypeError(`Unknown Recorded video mode ${mode}.`);
    if (videoMode === mode && fallbackReason === reason) return videoModeSwitch;
    videoMode = mode;
    fallbackReason = reason;
    try {
      videoModeSwitch = Promise.resolve(switchVideoMode(mode, reason));
    } catch (error) {
      videoModeSwitch = Promise.reject(error);
    }
    onStateChange(snapshot());
    return videoModeSwitch;
  };
  const wakeProgress = () => {
    const wake = progressWaiter;
    progressWaiter = null;
    wake?.();
  };
  const active = generation => generation === intent && !streamController?.signal.aborted;
  const waitForProgress = generation => new Promise((resolve, reject) => {
    if (!active(generation)) {
      reject(abortError());
      return;
    }
    progressWaiter = resolve;
  });
  const waitForLowWater = async generation => {
    while (active(generation) && commonAhead() > lowWallSeconds * playbackRate) {
      await waitForProgress(generation);
    }
    if (!active(generation)) throw abortError();
  };
  const startPlayback = quotaLimited => {
    if (playbackStarted) return true;
    const required = (quotaLimited ? quotaStartWallSeconds : highWallSeconds) * playbackRate;
    if (commonAhead() + 0.001 < required) return false;
    playbackStarted = true;
    quotaLimitedStartup = quotaLimited;
    let playResult;
    try {
      playResult = play();
    } catch (error) {
      playResult = Promise.reject(error);
    }
    onPlaybackStart({quotaLimited, playResult, diagnostics: snapshot()});
    return true;
  };
  const retryQuotaWhenSafe = async generation => {
    const canConsume = startPlayback(true) || playbackStarted;
    if (!canConsume && presentedTime === null) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_ATOMIC_COMMIT_FAILED,
        'Quota was reached before 0.5 wall-clock seconds of common A/V or safe presented history existed.',
        snapshot());
    }
    while (active(generation)) {
      const blocked = [...queues.values()].filter(queue => queue.quotaBlocked);
      if (!blocked.length) return;
      const removeEnd = presentedTime === null ? null : presentedTime - 3;
      const safe = removeEnd !== null && blocked.every(queue =>
        queue.canRetryQuotaAfterRemove?.(removeEnd) ?? false);
      if (safe) {
        for (const queue of blocked) {
          if (!queue.retryQuotaAfterRemove(removeEnd)) {
            throw new MseRecordedPlaybackError(
              MSE_RECORDED_ATOMIC_COMMIT_FAILED,
              'The safe presented-history removal changed before quota retry.', snapshot());
          }
        }
        await Promise.all([...queues.values()].map(queue =>
          queue.waitStable?.() ?? queue.waitIdle?.()));
        return;
      }
      await waitForProgress(generation);
      startPlayback(true);
    }
    throw abortError();
  };
  const waitForQueues = async generation => {
    try {
      await Promise.all([...queues.values()].map(queue =>
        queue.waitStable?.() ?? queue.waitIdle?.()));
    } catch (error) {
      const quotaError = error instanceof MseAppendQuotaError ||
        error?.name === 'MseAppendQuotaError' || error?.code === 'MSE_APPEND_QUOTA';
      if (!quotaError) throw error;
      await retryQuotaWhenSafe(generation);
    }
  };
  const commitFragment = async (generation, data, offset) => {
    transition('committing');
    await videoModeSwitch;
    const accepted = await demuxer.push(data);
    if (accepted === false) {
      throw new MseRecordedPlaybackError(
        MSE_RECORDED_ATOMIC_COMMIT_FAILED, `The demuxer rejected input at ${offset}.`, snapshot());
    }
    await waitForQueues(generation);
    if (!active(generation)) throw abortError();
    transition('running');
    if (seekState === 'seek-resume') transitionSeek(null);
    startPlayback(false);
  };
  const feed = async generation => {
    streamController = new AbortController();
    try {
      transition(nextOffset === 0n ? 'locating-audio' : 'running');
      for await (const data of source.stream(nextOffset, {signal: streamController.signal})) {
        if (!active(generation)) throw abortError();
        if (!(data instanceof Uint8Array) || data.byteLength === 0) {
          throw new MseRecordedPlaybackError(
            MSE_RECORDED_SOURCE_FAILED, `The source returned an empty fragment at ${nextOffset}.`, snapshot());
        }
        const offset = nextOffset;
        if (commonAhead() >= highWallSeconds * playbackRate) await waitForLowWater(generation);
        await commitFragment(generation, data, offset);
        const length = BigInt(data.byteLength);
        nextOffset += length;
        bytesRead += length;
        lastProgress = {offset: offset.toString(), bytes: data.byteLength};
        onProgress(snapshot());
      }
      if (generation === intent) {
        transition('ended');
        completion?.resolve();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== intent) return;
      transition('error');
      const failure = error instanceof MseRecordedPlaybackError ? error : new MseRecordedPlaybackError(
        MSE_RECORDED_SOURCE_FAILED, error?.message ?? String(error), snapshot());
      completion?.reject(failure);
      throw failure;
    }
  };
  const beginFeed = () => {
    const generation = intent;
    feedPromise = feed(generation);
    return feedPromise;
  };
  const cancelFeed = async () => {
    streamController?.abort();
    wakeProgress();
    try { await feedPromise; } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    }
    feedPromise = null;
    streamController = null;
  };
  const locateTransaction = async (target, generation, installClock) => {
    transition('locating-audio');
    if (installClock) transitionSeek('seek-audio-anchor');
    const transactionController = new AbortController();
    streamController = transactionController;
    await demuxer.beginMseRecordedSeek?.();
    try {
      const result = await locateSeekWindow({
        targetTimeSeconds: target,
        readBudgetBytes: BigInt(readBudgetBytes),
        signal: transactionController.signal,
        transition: next => transition(next),
        seekTransition: installClock ? next => transitionSeek(next) : () => {},
        waitForQueues: () => waitForQueues(generation),
      });
      if (!result || result.nextOffset === undefined || !VIDEO_MODES.has(result.videoMode)) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_VIDEO_NOT_FOUND,
          'No preferred, rainfall, or prior closed video covers the AAC target window.', snapshot());
      }
      if (BigInt(result.bytesRead ?? 0n) > BigInt(readBudgetBytes)) {
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_AUDIO_ANCHOR_NOT_FOUND,
          'The AAC target window exceeded the 16 MiB transaction budget.', snapshot());
      }
      if (installClock) transitionSeek('seek-commit');
      transition('committing');
      await waitForQueues(generation);
      if (!active(generation)) throw abortError();
      await demuxer.finishMseRecordedSeek?.(BigInt(Math.round(target * 1000000)));
      nextOffset = BigInt(result.nextOffset);
      bytesRead += BigInt(result.bytesRead ?? 0n);
      setMode(result.videoMode, result.videoMode === 'preferred' ? null : 'source-damage');
      if (installClock) media.currentTime = target;
      if (installClock) transitionSeek('seek-resume');
      transition('running');
      startPlayback(false);
      if (streamController === transactionController) streamController = null;
      return result;
    } catch (error) {
      await demuxer.cancelMseRecordedSeek?.();
      if (installClock) transitionSeek(null);
      throw error;
    }
  };
  const fail = error => {
    transition('error');
    const failure = error instanceof MseRecordedPlaybackError ? error : new MseRecordedPlaybackError(
      MSE_RECORDED_SOURCE_FAILED, error?.message ?? String(error), snapshot());
    completion?.reject(failure);
    return failure;
  };

  return {
    get state() { return state; },
    get videoMode() { return videoMode; },
    get nextOffset() { return nextOffset; },
    get bytesRead() { return bytesRead; },
    watermarks() {
      return {
        highMediaSeconds: highWallSeconds * playbackRate,
        lowMediaSeconds: lowWallSeconds * playbackRate,
      };
    },
    diagnostics: snapshot,
    setPlaybackRate(rate) {
      playbackRate = finiteNonNegative(rate, 'playbackRate');
      if (!(playbackRate > 0)) throw new TypeError('playbackRate must be positive.');
      wakeProgress();
      return this.watermarks();
    },
    notifyPresentedFrame(mediaTimeSeconds) {
      presentedTime = finiteNonNegative(mediaTimeSeconds, 'mediaTimeSeconds');
      wakeProgress();
    },
    notifyConsumption() { wakeProgress(); },
    reportSourceDamage({damageStartTimeSeconds = media.currentTime,
      fallbackVideoTrack = null} = {}) {
      damageStart = finiteNonNegative(damageStartTimeSeconds, 'damageStartTimeSeconds');
      candidateRap = null;
      transitionContinuity('damage-sealed');
      fallbackTrack = fallbackVideoTrack;
      if (fallbackVideoTrack === null || fallbackVideoTrack === undefined) {
        transitionContinuity('frozen');
        return setMode('frozen', 'source-damage');
      }
      transitionContinuity('fallback-pending');
      return setMode('rainfall', 'source-damage').then(accepted => {
        if (accepted === false && fallbackReason === 'source-damage') {
          fallbackTrack = null;
          transitionContinuity('frozen');
          return setMode('frozen', 'source-damage');
        }
        return accepted;
      });
    },
    reportVideoRecovery(event = {}) {
      if (event.damageStartUs !== null && event.damageStartUs !== undefined) {
        damageStart = Number(BigInt(event.damageStartUs)) / 1000000;
      }
      if (event.aacFrontierUs !== null && event.aacFrontierUs !== undefined) {
        aacFrontier = Number(BigInt(event.aacFrontierUs)) / 1000000;
      }
      if (event.frozenThroughUs !== null && event.frozenThroughUs !== undefined) {
        frozenThrough = Number(BigInt(event.frozenThroughUs)) / 1000000;
      }
      if (event.candidateRapUs !== null && event.candidateRapUs !== undefined) {
        candidateRap = Number(BigInt(event.candidateRapUs)) / 1000000;
      }
      if (event.fallbackTrackId !== null && event.fallbackTrackId !== undefined) {
        fallbackTrack = event.fallbackTrackId;
      }
      if (event.lastVideoOutputEndUs !== null && event.lastVideoOutputEndUs !== undefined) {
        lastVideoOutputEnd = Number(BigInt(event.lastVideoOutputEndUs)) / 1000000;
      }
      if (event.continuityState && CONTINUITY_STATES.has(event.continuityState)) {
        transitionContinuity(event.continuityState);
      }
      if (event.continuityState === 'fallback-pending' && fallbackTrack !== null) {
        void setMode('rainfall', 'source-damage');
      } else if (event.continuityState === 'frozen') {
        void setMode('frozen', 'source-damage');
      }
      if (event.phase === 'candidate-rejected') transitionContinuity('frozen');
      if (event.phase === 'stable-rap-committed') {
        transitionContinuity('restoring');
        void setMode('preferred', null).then(() => {
          transitionContinuity('normal');
          damageStart = null;
          frozenThrough = null;
          candidateRap = null;
          fallbackTrack = null;
        });
      }
    },
    notifyPreferredStableRap() {
      if (fallbackReason === 'source-damage') {
        this.reportVideoRecovery({phase: 'stable-rap-committed'});
      }
    },
    reportPlaybackQuality({totalFrames, droppedFrames, durationSeconds = 5, mediaError = null}) {
      if (mediaError) {
        qualityFailures = 2;
        setMode('rainfall', 'decoder-performance');
        return videoMode;
      }
      const total = finiteNonNegative(totalFrames, 'totalFrames');
      const dropped = finiteNonNegative(droppedFrames, 'droppedFrames');
      const duration = finiteNonNegative(durationSeconds, 'durationSeconds');
      const healthyBuffer = commonAhead() >= playbackRate;
      const failed = duration >= 5 && total > 0 && dropped / total > 0.2 && healthyBuffer;
      qualityFailures = failed ? qualityFailures + 1 : 0;
      if (qualityFailures >= 2) setMode('rainfall', 'decoder-performance');
      return videoMode;
    },
    async start(targetTimeSeconds = media.currentTime) {
      const target = finiteNonNegative(targetTimeSeconds, 'targetTimeSeconds');
      const result = ensureCompletion();
      if (feedPromise) return result.promise;
      intent += 1;
      const generation = intent;
      feedPromise = (async () => {
        await locateTransaction(target, generation, false).catch(error => {
          if (error?.name === 'AbortError' || generation !== intent) return;
          throw fail(error);
        });
        if (generation !== intent) return;
        return feed(generation);
      })();
      void feedPromise.catch(() => {});
      return result.promise;
    },
    async seek(targetTimeSeconds) {
      const target = finiteNonNegative(targetTimeSeconds, 'targetTimeSeconds');
      intent += 1;
      await cancelFeed();
      qualityFailures = 0;
      fallbackReason = null;
      continuityState = 'normal';
      const generation = intent;
      try {
        const result = await locateTransaction(target, generation, true);
        intent += 1;
        ensureCompletion();
        void beginFeed().catch(() => {});
        return result;
      } catch (error) {
        if (error instanceof MseRecordedPlaybackError) throw error;
        transition('error');
        throw new MseRecordedPlaybackError(
          MSE_RECORDED_ATOMIC_COMMIT_FAILED, error?.message ?? String(error), snapshot());
      }
    },
    async stop() {
      intent += 1;
      await cancelFeed();
      transition('idle');
      completion?.resolve();
      completion = null;
    },
  };
}
