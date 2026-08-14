import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_layer_switch_sample.mjs DIST_JS SAMPLE_TLV');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const events = [];
let selectedInitialTracks = false;
let switchRequested = false;
let videoBoundary = null;
let audioBoundary = null;
let completedLayer = null;
let videoSegments = 0;
let replacementVideoSegments = 0;
let videoInits = 0;

const demuxer = new module.TlvDemuxer({
  onTrack(track) {
    tracks.set(track.packetId, track);
  },
  onMseInit(init) {
    events.push(`init:${init.type}`);
    if (init.type === 'video') videoInits += 1;
  },
  onMseVideoSplice(splice) {
    videoBoundary = BigInt(splice.presentationTimeUs);
    events.push('splice:video');
  },
  onMseAudioSplice(splice) {
    audioBoundary = BigInt(splice.presentationTimeUs);
    events.push('splice:audio');
  },
  onMseLayerSwitch(layer) {
    completedLayer = layer;
    events.push('complete:layer');
  },
  onMseSegment(segment) {
    events.push(`segment:${segment.type}`);
    if (segment.type === 'video') {
      videoSegments += 1;
      if (videoBoundary !== null) replacementVideoSegments += 1;
    }
  },
});

const input = await open(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(512 * 1024);
try {
  for (let position = 0; ; position += chunk.byteLength) {
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    if (!bytesRead) break;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);

    const highVideo = tracks.get(0xf300);
    const lowVideo = tracks.get(0xf301);
    const highAudio = tracks.get(0xf310);
    const lowAudio = tracks.get(0xf314);
    if (!selectedInitialTracks && highVideo && highAudio) {
      demuxer.selectTrack('video', highVideo.trackId);
      demuxer.selectTrack('audio', highAudio.trackId);
      selectedInitialTracks = true;
    }
    if (!switchRequested && lowVideo && lowAudio && videoSegments >= 2) {
      assert.equal(demuxer.switchLayer(lowVideo.trackId, lowAudio.trackId, 0n), true);
      switchRequested = true;
      events.push('request:layer');
    }
    if (completedLayer !== null && replacementVideoSegments >= 2) break;
  }
  demuxer.flush();
} finally {
  await input.close();
  demuxer.delete();
}

assert.equal(selectedInitialTracks, true, 'sample did not expose the initial A/V pair');
assert.equal(switchRequested, true, 'sample did not reach the layer-switch request');
assert.notEqual(videoBoundary, null, 'target video RAP did not create a splice boundary');
assert.notEqual(audioBoundary, null, 'prepared lower-layer audio did not splice');
assert.notEqual(completedLayer, null, 'WASM layer switch did not complete');
assert.equal(BigInt(completedLayer.videoPresentationTimeUs), videoBoundary);
assert.equal(BigInt(completedLayer.audioPresentationTimeUs), audioBoundary);
assert.ok(replacementVideoSegments > 0, 'no target-layer video media followed the splice');
assert.ok(videoInits >= 2, 'different target HEVC configuration did not emit a new init');
assert.ok(events.indexOf('splice:video') < events.lastIndexOf('init:video'));
assert.ok(events.indexOf('splice:video') < events.lastIndexOf('segment:video'));

console.log(JSON.stringify({
  videoBoundary: videoBoundary.toString(),
  audioBoundary: audioBoundary.toString(),
  videoInits,
  videoSegments,
  eventTail: events.slice(-16),
}, null, 2));
