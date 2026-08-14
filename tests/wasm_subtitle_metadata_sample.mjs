import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_subtitle_metadata_sample.mjs DIST_JS SAMPLE_TLV');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const subtitleTracks = [];
const demuxer = new module.TlvDemuxer({
  onTrack(track) {
    if (track.kind === 'subtitle') subtitleTracks.push(track);
  },
});
const input = await open(resolve(samplePathArgument), 'r');
try {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  const {bytesRead} = await input.read(bytes, 0, bytes.byteLength, 0);
  assert.equal(demuxer.push(bytes.subarray(0, bytesRead)), true);
} finally {
  await input.close();
  demuxer.delete();
}

const caption = subtitleTracks.find(track => track.subtitle?.type === 0);
const superimpose = subtitleTracks.find(track => track.subtitle?.type === 1);
assert.ok(caption, 'sample did not expose a caption track');
assert.ok(superimpose, 'sample did not expose a character-superimpose track');
assert.equal(caption.packetId, 0xf330);
assert.equal(superimpose.packetId, 0xf338);
for (const track of [caption, superimpose]) {
  assert.equal(typeof track.subtitle.displayMode, 'number');
  assert.equal(typeof track.subtitle.operationMode, 'number');
  assert.equal(typeof track.subtitle.timingMode, 'number');
}

console.log(JSON.stringify({
  caption: {packetId: caption.packetId, componentTag: caption.componentTag,
    subtitle: caption.subtitle},
  superimpose: {packetId: superimpose.packetId, componentTag: superimpose.componentTag,
    subtitle: superimpose.subtitle},
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
