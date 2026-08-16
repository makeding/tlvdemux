import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const modulePath = resolve(process.argv[2] || '../build-wasm/tlvdemux.js');
const createModule = createRequire(import.meta.url)(modulePath);
const module = await createModule();
const demuxer = new module.TlvDemuxer({});
const lut = demuxer.hlgSdrToneMappingLut();
const colorLut = demuxer.hlgSdrColorLut();
const prototypeColorLut = demuxer.hlgSdrPrototypeColorLut();

assert.ok(lut instanceof Uint8Array);
assert.equal(lut.length, 1024);
assert.equal(lut[0], 0);
assert.equal(lut[409], 102);
assert.equal(lut[767], 214);
assert.equal(lut[808], 240);
assert.equal(lut[1023], 255);
for (let index = 1; index < lut.length; index += 1) {
  assert.ok(lut[index] >= lut[index - 1]);
}
assert.equal(colorLut.size, 33);
assert.equal(colorLut.width % colorLut.size, 0);
assert.equal(colorLut.height % colorLut.size, 0);
assert.ok((colorLut.width / colorLut.size) *
  (colorLut.height / colorLut.size) >= colorLut.size);
assert.ok(colorLut.data instanceof Uint8Array);
assert.equal(colorLut.data.length, colorLut.width * colorLut.height * 4);
assert.deepEqual([...colorLut.data.subarray(0, 4)], [0, 0, 0, 255]);
const columns = colorLut.width / colorLut.size;
const whiteX = ((colorLut.size - 1) % columns) * colorLut.size + colorLut.size - 1;
const whiteY = Math.floor((colorLut.size - 1) / columns) * colorLut.size +
  colorLut.size - 1;
const whiteOffset = (whiteY * colorLut.width + whiteX) * 4;
assert.deepEqual([...colorLut.data.subarray(whiteOffset, whiteOffset + 4)],
  [255, 255, 255, 255]);
assert.equal(prototypeColorLut.size, 128);
assert.equal(prototypeColorLut.width, 1536);
assert.equal(prototypeColorLut.height, 1408);
assert.equal(prototypeColorLut.data.length,
  prototypeColorLut.width * prototypeColorLut.height * 4);
demuxer.delete();
console.log('HLG-SDR C++ LUT tests passed');
