import assert from 'node:assert/strict';

const [debugBase = 'http://127.0.0.1:9335', targetSecondsText = '70', sourceUrl,
  playbackRateText, startTimeText] = process.argv.slice(2);
const targetSeconds = Number(targetSecondsText);
assert.ok(Number.isFinite(targetSeconds) && targetSeconds > 0, 'invalid target seconds');
const requestedPlaybackRate = playbackRateText === undefined ? null : Number(playbackRateText);
assert.ok(requestedPlaybackRate === null ||
  (Number.isFinite(requestedPlaybackRate) && requestedPlaybackRate > 0), 'invalid playback rate');
const requestedStartTime = startTimeText === undefined ? null : Number(startTimeText);
assert.ok(requestedStartTime === null ||
  (Number.isFinite(requestedStartTime) && requestedStartTime >= 0), 'invalid start time');

const targets = await (await fetch(`${debugBase}/json`)).json();
const target = targets.find(item => item.type === 'page' && item.url.includes('/demo/'));
assert.ok(target?.webSocketDebuggerUrl, 'demo page is not available through CDP');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(message.error.message));
  else handler.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const result = await call('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

if (sourceUrl) {
  await evaluate(`localStorage.setItem('tlvdemux.demo.httpUrl', ${JSON.stringify(sourceUrl)})`);
}
await evaluate(`(() => {
  const url = new URL(location.href);
  url.searchParams.set('tlvdemuxDebug', '1');
  history.replaceState(null, '', url);
})()`);
await call('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 500));
await evaluate(`new Promise((resolve, reject) => {
  const deadline = performance.now() + 30000;
  const start = () => {
    const state = document.getElementById('probeState')?.textContent || '';
    if (state.includes('再生中') || state.includes('バッファリング中')) {
      resolve(true);
      return;
    }
    const button = document.getElementById('normalButton');
    if (button && !button.disabled) { button.click(); resolve(true); return; }
    if (performance.now() >= deadline) {
      reject(new Error(JSON.stringify({
        reason: 'play button stayed disabled',
        probeState: document.getElementById('probeState')?.textContent,
        status: document.getElementById('status')?.textContent,
        log: document.getElementById('log')?.textContent,
        source: document.getElementById('httpUrl')?.value,
        mediaSource: typeof MediaSource,
      })));
      return;
    }
    setTimeout(start, 50);
  };
  start();
})`, true);
if (requestedPlaybackRate !== null) {
  await evaluate(`document.getElementById('video').playbackRate = ${requestedPlaybackRate}`);
}
if (requestedStartTime !== null) {
  await evaluate(`document.getElementById('video').currentTime = ${requestedStartTime}`);
}

const deadline = Date.now() + Math.max(90000, targetSeconds * 2000);
let state;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  state = await evaluate(`(() => {
    const video = document.getElementById('video');
    ${requestedPlaybackRate === null ? '' : `video.playbackRate = ${requestedPlaybackRate};`}
    const error = video.error;
    const quality = video.getVideoPlaybackQuality?.();
    const ranges = [];
    for (let i = 0; i < video.buffered.length; i++) ranges.push([video.buffered.start(i), video.buffered.end(i)]);
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      ended: video.ended,
      paused: video.paused,
      seeking: video.seeking,
      readyState: video.readyState,
      networkState: video.networkState,
      playbackRate: video.playbackRate,
      totalVideoFrames: quality?.totalVideoFrames ?? null,
      droppedVideoFrames: quality?.droppedVideoFrames ?? null,
      error: error ? { code: error.code, message: error.message } : null,
      ranges,
      status: document.getElementById('probeState')?.textContent,
      controller: globalThis.__tlvdemuxDebugRecordedController?.diagnostics().current ?? null,
      queues: [...(globalThis.__tlvdemuxDebugQueues?.entries() || [])].map(([type, queue]) => ({
        type,
        ...queue.snapshot(),
        timestampOffset: queue.sourceBuffer.timestampOffset,
        nextOperations: queue.queue.slice(0, 8).map(item => ({
          kind: item.kind,
          mime: item.mime,
          forceChangeType: item.forceChangeType,
          startTimeSeconds: item.startTimeSeconds,
          endTimeSeconds: item.endTimeSeconds,
          byteLength: item.data?.byteLength ?? 0,
          offsetSeconds: item.offsetSeconds,
        })),
        waiters: queue.waiters.length,
        retryPending: queue.retryTimer !== null,
        ahead: queue.bufferedAhead(),
        error: queue.error?.message || null,
      })),
      logTail: document.getElementById('log')?.textContent.split('\\n').slice(-8),
    };
  })()`);
  console.log(JSON.stringify(state));
  if (state.error) throw new Error(`media error at ${state.currentTime}s: ${state.error.message}`);
  if (state.controller?.state === 'failed' || /MSE_(?:SEEK|STARTUP)_/.test(state.status || '')) {
    throw new Error(`playback controller failed: ${JSON.stringify(state)}`);
  }
  if (state.currentTime >= targetSeconds) break;
}
socket.close();
assert.ok(state && state.currentTime >= targetSeconds,
  `playback did not reach ${targetSeconds}s: ${JSON.stringify(state)}`);
