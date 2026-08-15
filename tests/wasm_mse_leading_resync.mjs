import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [modulePath, samplePath] = process.argv.slice(2);
assert.ok(modulePath && samplePath,
  'usage: node tests/wasm_mse_leading_resync.mjs TLVDEMUX_JS SAMPLE.mmts');

const require = createRequire(import.meta.url);
const createTlvDemuxModule = require(resolve(modulePath));
const module = await createTlvDemuxModule();
const initSegments = new Set();
const mediaSegments = new Map([['video', 0], ['audio', 0]]);
const errors = [];
let videoTrack = null;
let audioTrack = null;
let demuxer;

demuxer = new module.TlvDemuxer({
  onTrack(track) {
    if (track.kind === 'video' && videoTrack === null) {
      videoTrack = track.trackId;
      demuxer.selectTrack('video', videoTrack);
    } else if (track.kind === 'audio' && audioTrack === null) {
      audioTrack = track.trackId;
      demuxer.selectTrack('audio', audioTrack);
    }
  },
  onMseInit(init) { initSegments.add(init.type); },
  onMseSegment(segment) {
    mediaSegments.set(segment.type, mediaSegments.get(segment.type) + 1);
  },
  onError(error) { errors.push(error); },
});

const file = await open(samplePath, 'r');
const source = new Uint8Array(4 * 1024 * 1024);
const input = new Uint8Array(1160 + source.byteLength);
input.fill(0xff, 0, 1160);
try {
  const { bytesRead } = await file.read(source, 0, source.byteLength, 0);
  input.set(source.subarray(0, bytesRead), 1160);
  assert.equal(demuxer.push(input.subarray(0, 1160 + bytesRead)), true);
  demuxer.flush();
} finally {
  await file.close();
  demuxer.delete();
}

assert.equal(errors.some(error => error.inputOffset === 0 &&
  error.message === 'discarded bytes while searching for a validated TLV boundary'), false);
assert.ok(initSegments.has('video'), 'missing video init segment');
assert.ok(initSegments.has('audio'), 'missing audio init segment');
assert.ok(mediaSegments.get('video') > 0, 'missing video media segments');
assert.ok(mediaSegments.get('audio') > 0, 'missing audio media segments');

console.log(JSON.stringify({
  errors: errors.length,
  videoSegments: mediaSegments.get('video'),
  audioSegments: mediaSegments.get('audio'),
}));
