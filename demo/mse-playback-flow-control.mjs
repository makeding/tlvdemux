import {intersectBufferedRanges} from '../mse-append-queue.mjs?v=startup-buffer-v1';

export const MSE_STARTUP_NO_COMMON_AV = 'MSE_STARTUP_NO_COMMON_AV';

export class MseStartupBufferError extends Error {
  constructor(message =
    '映像と音声の開始時刻を再生位置へ揃えられませんでした。入力を確認して、もう一度再生してください。') {
    super(`${MSE_STARTUP_NO_COMMON_AV}: ${message}`);
    this.name = 'MseStartupBufferError';
    this.code = MSE_STARTUP_NO_COMMON_AV;
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

export function commonBufferedAhead(media, queues, toleranceSeconds = 0.05) {
  if (queues.size < 2) return 0;
  const currentTime = media.currentTime;
  const range = commonBufferedRanges(queues).find(item =>
    item.start <= currentTime + toleranceSeconds && item.end >= currentTime);
  return range ? Math.max(0, range.end - currentTime) : 0;
}

export function createMsePlaybackFlowControl({
  media,
  queues,
  highSeconds = 15,
  lowSeconds = 8,
  startupNoProgressBytes = 16 * 1024 * 1024,
  queueHighBytes = 4 * 1024 * 1024,
  backBufferSeconds = 8,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  let startupBytes = 0;
  let startupCovered = false;

  const trim = () => {
    for (const queue of queues.values()) {
      queue.trimBefore(media.currentTime - backBufferSeconds);
    }
  };

  const hasPerTrackMedia = () => queues.size >= 2 &&
    [...queues.values()].every(queue => queue.bufferedRanges().length > 0);

  return {
    commonAhead() {
      return commonBufferedAhead(media, queues);
    },

    async afterPush(byteLength, isActive = () => true) {
      trim();
      await Promise.all([...queues.values()].map(queue =>
        queue.waitFlowControlled(queueHighBytes)));
      if (!isActive()) return {commonAhead: 0, startupCovered};

      let ahead = commonBufferedAhead(media, queues);
      if (ahead > 0) {
        startupCovered = true;
      } else if (!startupCovered) {
        startupBytes += byteLength;
        if (hasPerTrackMedia()) {
          throw new MseStartupBufferError(
            '映像と音声は追加されましたが、現在の再生位置を覆う共通バッファがありません。');
        }
        if (startupBytes >= startupNoProgressBytes) {
          throw new MseStartupBufferError(
            `${startupNoProgressBytes} bytes 読み込んでも共通 A/V バッファを作成できませんでした。`);
        }
      }

      if (ahead < highSeconds) return {commonAhead: ahead, startupCovered};
      while (isActive() && ahead > lowSeconds) {
        trim();
        await wait(250);
        ahead = commonBufferedAhead(media, queues);
      }
      return {commonAhead: ahead, startupCovered};
    },
  };
}
