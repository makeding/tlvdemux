import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const modulePath = process.argv[2];
assert.ok(modulePath, 'missing generated tlvdemux-wasm module path');
const require = createRequire(import.meta.url);
const createTlvDemuxModule = require(resolve(modulePath));
const module = await createTlvDemuxModule();

const append16 = (data, value) => data.push((value >>> 8) & 0xff, value & 0xff);
const append32 = (data, value) => data.push(
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
);

function crc32Mpeg(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x80000000) !== 0
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function tlv(type, payload) {
  return new Uint8Array([0x7f, type, payload.length >>> 8, payload.length & 0xff, ...payload]);
}

function extendedSection(tableId, extension, version, body) {
  const section = [tableId, 0xf0, 0];
  append16(section, extension);
  section.push(0xc1 | ((version & 0x1f) << 1), 0, 0, ...body);
  const sectionLength = section.length - 3 + 4;
  section[1] = 0xf0 | (sectionLength >>> 8);
  section[2] = sectionLength & 0xff;
  append32(section, crc32Mpeg(section));
  assert.equal(crc32Mpeg(section), 0);
  return section;
}

function ipv6Ntp() {
  const data = [0x60, 0, 0, 0, 0, 56, 17, 32];
  data.push(...new Array(15).fill(0), 2);
  data.push(...new Array(14).fill(0), 1, 1);
  append16(data, 456);
  append16(data, 123);
  append16(data, 56);
  append16(data, 0);
  data.push(0x25, 2, 6, 0xfa, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0);
  for (let index = 0; index < 3; ++index) {
    append32(data, 0);
    append32(data, 0);
  }
  append32(data, 0xa5622500);
  append32(data, 0x80000000);
  return data;
}

function compressedFlow() {
  const data = [0, 0x10, 0x60, 0x60, 0, 0, 0, 17, 32];
  data.push(...new Array(15).fill(0), 1);
  data.push(...new Array(15).fill(0), 2);
  append16(data, 50000);
  append16(data, 51216);
  data.push(
    0, 2, 0x80, 0,
    0, 0, 0, 0,
    0, 0, 0, 1,
    0, 0, 0x12, 0x34,
  );
  return data;
}

function nit() {
  const body = [0xf0, 3, 0xe1, 1, 0xaa];
  const streams = [0x01, 0x00, 0x00, 0x0b, 0xf0, 3, 0x41, 1, 0x60];
  body.push(0xf0, streams.length, ...streams);
  return extendedSection(0x40, 0x000b, 3, body);
}

function addressMap() {
  const body = [0x00, 0x7f, 0x00, 0x65, 0xfc, 0x24];
  body.push(...new Array(15).fill(0), 2, 128);
  body.push(...new Array(14).fill(0), 0xff, 0x3e, 128, 0xde, 0xad);
  return extendedSection(0xfe, 0, 2, body);
}

const events = {
  errors: [],
  flows: [],
  ntp: [],
  nit: [],
  maps: [],
  raw: [],
  unknown: [],
  signalling: [],
};
const demuxer = new module.TlvDemuxer({
  onError: event => events.errors.push(event),
  onIpDataFlow: event => events.flows.push(event),
  onTransportNtpClock: event => events.ntp.push(event),
  onTlvNetworkInformation: event => events.nit.push(event),
  onAddressMap: event => events.maps.push(event),
  onRawSignallingTable: event => events.raw.push(event),
  onUnknownDescriptor: event => events.unknown.push(event),
  onSignallingMessage: event => events.signalling.push(event),
});

demuxer.push(tlv(0x02, ipv6Ntp()));
demuxer.push(tlv(0x03, compressedFlow()));
demuxer.push(tlv(0xfe, nit()));
demuxer.push(tlv(0xfe, addressMap()));
demuxer.flush();
demuxer.delete();

assert.deepEqual(events.errors, []);
assert.equal(events.ntp.length, 1);
assert.equal(events.ntp[0].destinationPort, 123);
assert.equal(events.ntp[0].transmitTimestamp, 0xa562250080000000n);
assert.equal(events.flows.length, 1);
assert.equal(events.flows[0].contextId, 1);
assert.equal(events.flows[0].sourcePort, 50000);
assert.equal(events.flows[0].destinationPort, 51216);
assert.equal(events.signalling.length, 1);
assert.equal(events.signalling[0].messageId, 0x1234);
assert.equal(events.nit.length, 1);
assert.equal(events.nit[0].networkId, 0x000b);
assert.equal(events.unknown.length, 1);
assert.equal(events.unknown[0].tag, 0xe1);
assert.equal(events.maps.length, 1);
assert.equal(events.maps[0].services[0].ipVersion, 6);
assert.equal(events.maps[0].services[0].serviceId, 0x0065);
assert.equal(events.raw.length, 2);

console.log('tlvdemux WASM transport metadata test passed');
