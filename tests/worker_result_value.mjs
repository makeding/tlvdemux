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
    this.messages.push({message, transfer});
    queueMicrotask(() => {
      if (message.type === protocol.invoke) {
        const value = message.method === 'switchAudioTrack' ? null : true;
        this.onmessage?.({data: {type: protocol.result, requestId: message.requestId, value}});
      } else {
        this.onmessage?.({data: {type: protocol.result, requestId: message.requestId, value: true}});
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
await demuxer.push(bytes);
const pushMessage = fake.messages.find(entry => entry.message.method === 'push');
assert.deepEqual(pushMessage.transfer, [bytes.buffer]);
demuxer.delete();
assert.equal(demuxer.isDeleted(), true);
fake.event(1, 'onTrack', {trackId: 3n});
assert.equal(eventCount, 1);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(fake.messages.some(entry => entry.message.type === protocol.destroy), true);
module.close();
assert.equal(fake.closed, true);

console.log('worker result value tests passed');
