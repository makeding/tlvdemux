import assert from 'node:assert/strict';

const [debugBase = 'http://127.0.0.1:9336', backwardTargetText = '195.19798',
  forwardTargetText = '399.218'] =
  process.argv.slice(2);
const backwardTarget = Number(backwardTargetText);
const forwardTarget = Number(forwardTargetText);
assert.ok(Number.isFinite(backwardTarget) && backwardTarget >= 0,
  'invalid backward seek target');
assert.ok(Number.isFinite(forwardTarget) && forwardTarget >= 0,
  'invalid forward seek target');
const backwardLogTime = backwardTarget.toFixed(3);
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
const snapshot = () => evaluate(`(() => {
  const video = document.getElementById('video');
  const controller = globalThis.__tlvdemuxDebugRecordedController;
  const ranges = [];
  for (let index = 0; index < video.buffered.length; index += 1) {
    ranges.push([video.buffered.start(index), video.buffered.end(index)]);
  }
  return {
    currentTime: video.currentTime,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    error: video.error ? {code: video.error.code, message: video.error.message} : null,
    status: document.getElementById('probeState')?.textContent,
    notice: document.getElementById('playbackNotice')?.textContent,
    freezeVisible: !document.getElementById('videoFreezeCanvas')?.hidden,
    log: document.getElementById('log')?.textContent,
    ranges,
    controller: controller ? controller.diagnostics().current : null,
  };
})()`);
const waitFor = async (label, predicate, timeoutMilliseconds = 90000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  let state = null;
  while (Date.now() < deadline) {
    state = await snapshot();
    if (state.error) throw new Error(`${label}: ${JSON.stringify(state)}`);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
};

await evaluate(`localStorage.setItem(
  'tlvdemux.demo.httpUrl',
  'http://127.0.0.1:8123/demo/rain.tlv'
)`);
await call('Page.reload', {ignoreCache: true});
await waitFor('demo startup', state =>
  state.controller !== null || state.status === '入力情報を確認中', 30000);
await evaluate(`(() => {
  const button = document.getElementById('normalButton');
  if (!button.disabled) button.click();
})()`);
await waitFor('Recorded controller creation', state => state.controller !== null, 30000);

await evaluate(`document.getElementById('video').currentTime = ${forwardTarget}`);
const eof = await waitFor('forward seek and EOF', state =>
  state.controller?.state === 'ended' &&
  state.log.includes(`シーク ${forwardTarget.toFixed(3)}s`), 90000);
const eofGeneration = eof.controller.generation;
await evaluate(`document.getElementById('video').currentTime = ${backwardTarget}`);
const pendingSeek = await waitFor('post-EOF visual freeze', state =>
  state.status === 'シーク先を確認中' && state.freezeVisible, 5000);
assert.equal(pendingSeek.currentTime, backwardTarget);
const landed = await waitFor('post-EOF backward seek', state =>
  state.controller?.generation > eofGeneration &&
  state.log.includes(`ユーザーシーク ${backwardLogTime}s`) &&
  state.log.includes(`シーク ${backwardLogTime}s`) &&
  state.currentTime >= backwardTarget &&
  state.readyState >= 2, 90000);

assert.notEqual(landed.controller.state, 'failed');
assert.equal(landed.freezeVisible, false,
  'the last-frame seek cover remained visible after exact A/V committed');
assert.doesNotMatch(`${landed.status}\n${landed.notice}\n${landed.log}`,
  /MSE_SEEK_NO_COMMON_AV|MSE_RECORDED_SESSION_UNAVAILABLE/);
assert.ok(landed.ranges.some(([start, end]) =>
  start <= backwardTarget + 0.000002 && end >= backwardTarget + 0.000002),
'post-EOF seek did not install a real buffered range covering the requested time');
console.log(JSON.stringify({
  eofGeneration,
  landedGeneration: landed.controller.generation,
  currentTime: landed.currentTime,
  state: landed.controller.state,
  ranges: landed.ranges,
  logTail: landed.log.split('\n').slice(-16),
}, null, 2));
socket.close();
