import assert from 'node:assert/strict';
import {
  TLV_DEMUX_WORKER_PROTOCOL as protocol,
  createWorkerTlvDemuxModule,
  workerResultValue,
} from '../worker-tlvdemux.mjs';

assert.equal(workerResultValue({value: null}), null);
assert.equal(workerResultValue({value: false}), false);
assert.equal(workerResultValue({value: 0}), 0);
assert.equal(workerResultValue({value: undefined}), undefined);
assert.equal(workerResultValue({}), true);

class FakeWorker {
  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
  }

  postMessage(message, transfer = []) {
    const transferByteLengths = transfer.map(buffer => buffer.byteLength);
    // Match browser Worker semantics: transfer detaches the SDK-side buffer.
    const delivered = structuredClone(message, {transfer});
    this.messages.push({message: delivered, transferByteLengths});
    queueMicrotask(() => {
      if (delivered.type === protocol.invoke) {
        const value = delivered.method === 'switchAudioTrack' ? null : true;
        this.onmessage?.({data: {type: protocol.result, requestId: delivered.requestId, value}});
      } else {
        this.onmessage?.({data: {type: protocol.result, requestId: delivered.requestId, value: true}});
      }
    });
  }

  event(objectId, name, value) {
    this.onmessage?.({data: {type: protocol.event, objectId, name, value}});
  }

  terminate() { this.closed = true; }
}

const fake = new FakeWorker();
let eventCount = 0;
const module = await createWorkerTlvDemuxModule({
  workerFactory: () => fake,
  workerUrl: 'worker.js',
  wasmUrl: 'tlvdemux.js',
});
const demuxer = new module.TlvDemuxer({onTrack: () => { eventCount += 1; }});
assert.equal(await demuxer.switchAudioTrack(2n, 3n), null);
fake.event(1, 'onTrack', {trackId: 2n});
assert.equal(eventCount, 1);
fake.event(1, 'onApplicationState', {
  contextId: 1,
  organizationId: 2,
  applicationId: 3,
  applicationEntry: '/index.html',
});
fake.event(1, 'onApplicationResourceView', {
  contextId: 1,
  componentTag: 4,
  transactionId: 5,
  downloadId: 6,
  mpuSequenceNumber: 7,
  itemId: 8,
  version: 9,
  path: '/index.html',
  contentType: 'text/html',
  generation: 10n,
  data: Uint8Array.of(11, 12),
});
fake.event(1, 'onBroadcastClock', {unixMilliseconds: 1000});
fake.event(1, 'onLayoutConfiguration', {planeWidth: 1920});
assert.equal(demuxer.applicationEntry(1), '/index.html');
assert.equal(demuxer.applications().length, 1);
assert.deepEqual(demuxer.applicationResources(), [{
  contextId: 1,
  componentTag: 4,
  transactionId: 5,
  downloadId: 6,
  mpuSequenceNumber: 7,
  itemId: 8,
  version: 9,
  path: '/index.html',
  contentType: 'text/html',
  size: 2,
  generation: 10n,
}]);
const cachedResource = demuxer.applicationResource(1, '/index.html');
assert.deepEqual([...cachedResource.data], [11, 12]);
cachedResource.data[0] = 99;
assert.deepEqual([...demuxer.applicationResource(1, '/index.html').data], [11, 12]);
assert.deepEqual(demuxer.broadcastClock(), {unixMilliseconds: 1000});
assert.deepEqual(demuxer.layoutConfiguration(), {planeWidth: 1920});
fake.event(1, 'onServiceStateReset', {});
assert.equal(demuxer.layoutConfiguration(), null);
fake.event(1, 'onApplicationResourcesReset', {});
assert.equal(demuxer.applicationEntry(1), null);
assert.equal(demuxer.applicationResources().length, 0);
const bytes = Uint8Array.of(1, 2, 3);
await demuxer.suspendAutomaticLayerSwitch(1n, 2n, 3n, 4n);
assert.equal(fake.messages.some(entry =>
  entry.message.method === 'suspendAutomaticLayerSwitch'), true,
  'worker proxy did not expose automatic-layer suspension');
await demuxer.setMseRecordedSeekConcealmentTarget(5n);
assert.deepEqual(fake.messages.find(entry =>
  entry.message.method === 'setMseRecordedSeekConcealmentTarget')?.message.args, [5n],
  'worker proxy did not forward the one-shot recorded-seek target');
await demuxer.flushMseRecordedSeekAudio();
assert.deepEqual(fake.messages.find(entry =>
  entry.message.method === 'flushMseRecordedSeekAudio')?.message.args, [],
  'worker proxy did not forward the Recorded-seek AAC prefix flush');
await demuxer.flushMseRecordedSeekLanding();
assert.deepEqual(fake.messages.find(entry =>
  entry.message.method === 'flushMseRecordedSeekLanding')?.message.args, [],
  'worker proxy did not forward the Recorded-seek final landing flush');
assert.equal(await demuxer.switchLayerAtPlaybackEntry(3n, 4n, 0n), true,
  'worker proxy lost the playback-entry layer-switch result');
await demuxer.push(bytes);
const pushMessage = fake.messages.find(entry => entry.message.method === 'push');
assert.deepEqual(pushMessage.transferByteLengths, [3]);
assert.deepEqual([...pushMessage.message.args[0]], [1, 2, 3]);
assert.doesNotThrow(() => bytes.subarray(0, 3),
  'worker demuxer left a detached ArrayBuffer after push');
assert.equal(bytes.buffer.byteLength, 3,
  'worker demuxer detached the caller-owned source buffer');
assert.deepEqual([...bytes.subarray(0, 3)], [1, 2, 3],
  'caller-owned source bytes were not reusable after worker push');
const edid = Uint8Array.of(4, 5);
await demuxer.setMseEdid(edid);
assert.equal(edid.buffer.byteLength, 2,
  'worker EDID configuration detached caller-owned bytes');
const durationProbe = new module.DurationProbe();
const durationBytes = Uint8Array.of(6, 7, 8, 9);
await durationProbe.pushRange(1, 0n, durationBytes, true);
assert.doesNotThrow(() => durationBytes.subarray(0, 4),
  'worker duration probe left a detached ArrayBuffer after pushRange');
assert.equal(durationBytes.buffer.byteLength, 4,
  'worker duration probe detached caller-owned range bytes');
durationProbe.delete();
demuxer.delete();
assert.equal(demuxer.isDeleted(), true);
fake.event(1, 'onTrack', {trackId: 3n});
assert.equal(eventCount, 1);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(fake.messages.some(entry => entry.message.type === protocol.destroy), true);
module.close();
assert.equal(fake.closed, true);

console.log('worker result value tests passed');
