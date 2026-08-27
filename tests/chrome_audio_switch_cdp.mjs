import assert from 'node:assert/strict';

const [debugBase = 'http://127.0.0.1:9335', sourceUrl] = process.argv.slice(2);
assert.ok(sourceUrl, 'a live MMTS source URL is required');

const targets = await (await fetch(`${debugBase}/json`)).json();
const target = targets.find(item => item.type === 'page' && item.url.includes('/demo/'));
assert.ok(target?.webSocketDebuggerUrl, 'demo page is not available through CDP');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
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
socket.addEventListener('close', () => {
  for (const handler of pending.values()) {
    handler.reject(new Error('CDP socket closed before the regression completed'));
  }
  pending.clear();
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});
const evaluate = async (expression, awaitPromise = false) => {
  const result = await call('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

await evaluate(`localStorage.setItem('tlvdemux.demo.httpUrl', ${JSON.stringify(sourceUrl)})`);
await call('Page.reload', {ignoreCache: true});
await delay(500);
await evaluate(`new Promise((resolve, reject) => {
  const deadline = performance.now() + 15000;
  const start = () => {
    const button = document.getElementById('normalButton');
    if (button && !button.disabled) { button.click(); resolve(true); return; }
    if (performance.now() >= deadline) { reject(new Error('play button stayed disabled')); return; }
    setTimeout(start, 50);
  };
  start();
})`, true);

async function state() {
  return evaluate(`(() => {
    const video = document.getElementById('video');
    const select = document.getElementById('audioTrack');
    return {
      currentTime: video.currentTime,
      readyState: video.readyState,
      paused: video.paused,
      error: video.error ? {code: video.error.code, message: video.error.message} : null,
      selected: select.value,
      options: [...select.options].map(option => ({
        value: option.value, disabled: option.disabled, text: option.textContent,
      })),
      queues: [...(globalThis.__tlvdemuxDebugQueues?.entries() || [])].map(([type, queue]) => ({
        type,
        state: queue.state,
        updating: queue.sourceBuffer.updating,
        queuedBytes: queue.queuedBytes,
        queueLength: queue.queue.length,
        ahead: queue.bufferedAhead(),
        error: queue.error?.message || null,
      })),
      log: document.getElementById('log')?.textContent || '',
    };
  })()`);
}

const readyDeadline = Date.now() + 45000;
let before;
while (Date.now() < readyDeadline) {
  await delay(250);
  before = await state();
  if (before.error) throw new Error(`media error before switch: ${before.error.message}`);
  const alternatives = before.options.filter(option =>
    option.value && !option.disabled && option.value !== before.selected);
  if (before.currentTime >= 1 && alternatives.length > 0) break;
}
assert.ok(before?.currentTime >= 1, `playback did not start: ${JSON.stringify(before)}`);
const alternatives = before.options.filter(option =>
  option.value && !option.disabled && option.value !== before.selected);
assert.ok(alternatives.length > 0, `a second supported audio track was not found: ${JSON.stringify(before)}`);

const original = before.selected;
const replacement = alternatives[0].value;
const initialSplices = (before.log.match(/音声バッファ切替境界/g) || []).length;
await evaluate(`(() => {
  const select = document.getElementById('audioTrack');
  select.value = ${JSON.stringify(replacement)};
  select.dispatchEvent(new Event('change', {bubbles: true}));
})()`);

const switchDeadline = Date.now() + 20000;
let after;
while (Date.now() < switchDeadline) {
  await delay(250);
  after = await state();
  if (after.error) throw new Error(`media error after switch: ${after.error.message}`);
  const splices = (after.log.match(/音声バッファ切替境界/g) || []).length;
  if (splices > initialSplices && after.currentTime >= before.currentTime + 1) break;
}

socket.close();
assert.equal(after.selected, replacement, 'the selected audio option did not commit');
assert.ok(after.currentTime >= before.currentTime + 1,
  `playback stalled across the audio switch: ${JSON.stringify(after)}`);
assert.ok(!after.log.includes('初期化待ちが長すぎます'), 'an MSE init was missing');
assert.ok(!after.log.includes('音声切替エラー'), 'the demo reported an audio switch failure');
assert.ok(after.queues.every(queue => queue.error === null),
  `an MSE queue failed: ${JSON.stringify(after.queues)}`);
console.log(JSON.stringify({
  original,
  replacement,
  beforeTime: before.currentTime,
  afterTime: after.currentTime,
  queues: after.queues,
  logTail: after.log.split('\n').slice(-20),
}, null, 2));
