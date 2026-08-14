import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_asset_groups_sample.mjs DIST_JS SAMPLE_TLV');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = [];
const demuxer = new module.TlvDemuxer({onTrack: track => tracks.push(track)});
const input = await open(resolve(samplePathArgument), 'r');
try {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  const {bytesRead} = await input.read(bytes, 0, bytes.byteLength, 0);
  assert.equal(demuxer.push(bytes.subarray(0, bytesRead)), true);
} finally {
  await input.close();
  demuxer.delete();
}

const groupsByPacketId = Object.fromEntries(tracks.map(track => [
  `0x${track.packetId.toString(16)}`,
  track.assetGroups.map(group => [group.groupIdentification, group.selectionLevel]),
]));
assert.deepEqual(groupsByPacketId['0xf300'], [[0x00, 0]]);
assert.deepEqual(groupsByPacketId['0xf301'], [[0x00, 1]]);
assert.deepEqual(groupsByPacketId['0xf310'], [[0x10, 0]]);
assert.deepEqual(groupsByPacketId['0xf314'], [[0x10, 1]]);
assert.deepEqual(groupsByPacketId['0xf311'], [[0x11, 0]]);
assert.deepEqual(groupsByPacketId['0xf315'], [[0x11, 1]]);

console.log(JSON.stringify(groupsByPacketId, null, 2));
