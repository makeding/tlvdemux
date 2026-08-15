import assert from 'node:assert/strict';

const modulePath = process.argv[2] || '../build-wasm/tlvdemux.js';
const createModule = (await import(modulePath)).default;
const module = await createModule();
const demuxer = new module.TlvDemuxer({});
const lut = demuxer.hlgSdrToneMappingLut();

assert.ok(lut instanceof Uint8Array);
assert.equal(lut.length, 1024);
assert.equal(lut[0], 0);
assert.equal(lut[409], 102);
assert.equal(lut[767], 229);
assert.equal(lut[808], 255);
assert.equal(lut[1023], 255);
for (let index = 1; index < lut.length; index += 1) {
  assert.ok(lut[index] >= lut[index - 1]);
}
demuxer.delete();
console.log('HLG-SDR C++ LUT tests passed');
