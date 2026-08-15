import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';

const [modulePath, mediaPath, outputDirectory, maximumBytesText] = process.argv.slice(2);
assert.ok(modulePath && mediaPath && outputDirectory,
  'usage: node tests/wasm_audio_config_switch_sample.mjs MODULE SAMPLE OUTPUT_DIR [MAX_BYTES]');
const maximumBytes = Number(maximumBytesText ?? 64 * 1024 * 1024);
assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'invalid MAX_BYTES');
mkdirSync(outputDirectory, { recursive: true });

const require = createRequire(import.meta.url);
const createTlvDemuxModule = require(modulePath);
const module = await createTlvDemuxModule();
const descriptors = new Map();
const audioInits = [];
const events = [];
const segmentCounts = { audio: 0, video: 0 };
let audioGeneration = 0;
let videoGeneration = 0;
let videoTrack = null;
let audioTrack = null;
let demuxer;

const openGeneration = (type, generation) => {
  const descriptor = openSync(`${outputDirectory}/${type}-${generation}.mp4`, 'w');
  descriptors.set(type, descriptor);
  return descriptor;
};
const write = (type, data) => {
  const descriptor = descriptors.get(type);
  assert.notEqual(descriptor, undefined, `${type} media arrived before its init`);
  let offset = 0;
  while (offset < data.byteLength) offset += writeSync(descriptor, data, offset);
};

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
  onMseInit(init) {
    events.push(`init:${init.type}`);
    if (init.type === 'audio') {
      if (descriptors.has('audio')) closeSync(descriptors.get('audio'));
      audioGeneration += 1;
      audioInits.push({ generation: audioGeneration, channels: init.channels, mime: init.mime });
      openGeneration('audio', audioGeneration);
    } else if (init.type === 'video') {
      if (descriptors.has('video')) closeSync(descriptors.get('video'));
      videoGeneration += 1;
      openGeneration('video', videoGeneration);
    }
    write(init.type, init.data);
  },
  onMseSegment(segment) {
    events.push(`segment:${segment.type}`);
    write(segment.type, segment.data);
    segmentCounts[segment.type] += 1;
  },
  onMseAudioSplice() {
    events.push('splice');
  },
  onError(error) {
    if (!error.recoverable) throw new Error(JSON.stringify(error));
  },
});

const input = openSync(mediaPath, 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
let position = 0;
try {
  while (position < maximumBytes) {
    const length = Math.min(chunk.byteLength, maximumBytes - position);
    const bytesRead = readSync(input, chunk, 0, length, position);
    if (bytesRead === 0) break;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);
    position += bytesRead;
  }
  demuxer.flush();
} finally {
  closeSync(input);
  demuxer.delete();
  for (const descriptor of descriptors.values()) closeSync(descriptor);
}

assert.ok(audioInits.length >= 2, `expected an audio init after LATM config change: ${JSON.stringify(audioInits)}`);
assert.deepEqual(audioInits.slice(0, 2).map((init) => init.channels), [6, 2]);
const spliceIndex = events.indexOf('splice');
assert.ok(spliceIndex >= 0 && events[spliceIndex + 1] === 'init:audio',
  `audio splice was not immediately followed by the replacement init: ${events.slice(spliceIndex - 2, spliceIndex + 3)}`);
assert.ok(segmentCounts.audio > 0, 'no audio media segments');
console.log(JSON.stringify({ bytesRead: position, audioInits, segments: segmentCounts }));
