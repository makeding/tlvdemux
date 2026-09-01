import {coalesceReadableStream} from '../stream-input.mjs?v=public-stream-v1';
import {
  RangeUnsupportedError,
  createBlobRecordedSource,
  openHttpRecordedSource,
  probeRecordedDuration,
} from '../recorded-source.mjs?v=public-source-v1';

export {RangeUnsupportedError};

export function durationSeconds(duration) {
  return Number(duration.value) / duration.timescale;
}

export function timestampMicroseconds(timestamp) {
  return BigInt(timestamp.value) * 1000000n / BigInt(timestamp.timescale);
}

export function formatDuration(duration) {
  const seconds = durationSeconds(duration);
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${clock} (${seconds.toFixed(6)}s)`;
}

export function createDemoRecordedSource({
  file, rawUrl, baseUrl, liveMode, signal, livePushTargetBytes, livePushMaxDelayMilliseconds,
}) {
  if (file) return createBlobRecordedSource(file);
  if (!rawUrl) throw new Error('ローカル MMTS ファイルまたは HTTP URL を指定してください');
  const url = new URL(rawUrl, baseUrl).href;
  if (!liveMode) return openHttpRecordedSource({url, signal});
  return {
    identity: `live:${url}`,
    label: url,
    size: null,
    async *stream() {
      const response = await fetch(url, {signal});
      if (!response.ok || !response.body) {
        throw new Error(`Live HTTP リクエストに失敗しました: ${response.status}`);
      }
      yield* coalesceReadableStream(response.body.getReader(), {
        targetBytes: livePushTargetBytes,
        maxDelayMilliseconds: livePushMaxDelayMilliseconds,
      });
    },
  };
}

export async function probeDemoRecordedDuration({
  wasmModule, source, initialRangeSize, maxRangeSize, videoPacketId, isActive,
  onProbe, onProbeDone, onRange, onProgress,
}) {
  if (maxRangeSize < initialRangeSize) throw new Error('最大 Range は初期 Range 以上にしてください');
  const options = {initialRangeSize, maxRangeSize};
  if (videoPacketId !== undefined) options.videoPacketId = videoPacketId;
  const probe = new wasmModule.DurationProbe();
  onProbe?.(probe);
  try {
    const result = await probeRecordedDuration({source, probe, options, isActive, onRange, onProgress});
    return result;
  } finally {
    onProbeDone?.(probe);
  }
}
