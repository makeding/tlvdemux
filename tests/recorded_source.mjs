import assert from 'node:assert/strict';
import {
  RangeUnsupportedError,
  createBlobRecordedSource,
  openHttpRecordedSource,
  parseContentRange,
  probeRecordedDuration,
} from '../recorded-source.mjs';

assert.deepEqual(parseContentRange('bytes 4-7/12'), {start: 4n, end: 7n, size: 12n});
assert.equal(parseContentRange('bytes */12'), null);

const blobSource = createBlobRecordedSource(new Blob([Uint8Array.of(1, 2, 3, 4)]));
assert.deepEqual([...await blobSource.read(1n, 2n)], [2, 3]);
await assert.rejects(blobSource.read(3n, 2n), RangeError);

const payload = Uint8Array.from({length: 16}, (_, index) => index);
const requestedRanges = [];
const rangeFetch = async (_url, {headers}) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range'));
  assert.ok(match);
  const start = Number(match[1]);
  const end = Number(match[2]);
  requestedRanges.push([start, end]);
  return new Response(payload.slice(start, end + 1), {
    status: 206,
    headers: {'Content-Range': `bytes ${start}-${end}/${payload.byteLength}`},
  });
};
const httpSource = await openHttpRecordedSource({url: 'https://example.invalid/a.tlv', fetch: rangeFetch});
assert.equal(httpSource.size, 16n);
assert.deepEqual([...await httpSource.read(5n, 4n)], [5, 6, 7, 8]);
assert.deepEqual(requestedRanges, [[0, 0], [5, 8]]);

await assert.rejects(
  openHttpRecordedSource({
    url: 'https://example.invalid/no-range.tlv',
    fetch: async () => new Response(payload, {status: 200}),
  }),
  RangeUnsupportedError,
);
await assert.rejects(
  openHttpRecordedSource({
    url: 'https://example.invalid/truncated.tlv',
    fetch: async () => new Response(new Uint8Array(), {
      status: 206,
      headers: {'Content-Range': 'bytes 0-0/16'},
    }),
  }),
  RangeUnsupportedError,
);

const events = [];
let probeState = 'idle';
let deleted = false;
const probe = {
  begin(size, options) {
    assert.equal(size, 16n);
    assert.deepEqual(options, {initialRangeSize: 4n});
    probeState = 'need-range';
    return true;
  },
  state: () => probeState,
  failure: () => '',
  nextRange: () => ({requestId: 7n, offset: 4n, length: 3n}),
  pushRange(requestId, offset, data, end) {
    assert.deepEqual([requestId, offset, [...data], end], [7n, 4n, [4, 5, 6], true]);
    probeState = 'complete';
    return true;
  },
  duration: () => ({value: 90000n, timescale: 90000}),
  presentationStart: () => ({value: 9000n, timescale: 90000}),
  presentationEnd: () => ({value: 99000n, timescale: 90000}),
  selectedVideoPacketId: () => 0x101,
  presentationEndVideoPacketId: () => 0x102,
  transferredBytes: () => 3n,
  delete: () => { deleted = true; },
};
const duration = await probeRecordedDuration({
  source: httpSource,
  probe,
  options: {initialRangeSize: 4n},
  onRange: range => events.push(['range', range]),
  onProgress: progress => events.push(['progress', progress]),
});
assert.deepEqual(duration, {
  duration: {value: 90000n, timescale: 90000},
  presentationStart: {value: 9000n, timescale: 90000},
  presentationEnd: {value: 99000n, timescale: 90000},
  selectedVideoPacketId: 0x101,
  presentationEndVideoPacketId: 0x102,
  transferredBytes: 3n,
  rangeCount: 1,
});
assert.equal(deleted, true);
assert.equal(events.length, 2);

let cancelled = false;
let cancelledDeleted = false;
const cancelledProbe = {
  begin: () => true,
  state: () => 'need-range',
  failure: () => '',
  nextRange: () => ({requestId: 1n, offset: 0n, length: 1n}),
  pushRange: () => true,
  duration: () => ({value: 0n, timescale: 1}),
  presentationStart: () => ({value: 0n, timescale: 1}),
  presentationEnd: () => ({value: 0n, timescale: 1}),
  cancel: () => { cancelled = true; },
  delete: () => { cancelledDeleted = true; },
};
await assert.rejects(
  probeRecordedDuration({
    source: blobSource,
    probe: cancelledProbe,
    isActive: () => false,
  }),
  error => error?.name === 'AbortError',
);
assert.equal(cancelled, false);
assert.equal(cancelledDeleted, true);

console.log('recorded source tests passed');
