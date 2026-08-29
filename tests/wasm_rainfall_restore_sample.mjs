import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const [modulePathArgument, samplePathArgument] = process.argv.slice(2);
assert.ok(modulePathArgument && samplePathArgument,
  'usage: node tests/wasm_rainfall_restore_sample.mjs DIST_JS SAMPLE');

const require = createRequire(import.meta.url);
const createModule = require(resolve(modulePathArgument));
const module = await createModule();
const tracks = new Map();
const switchStarts = [];
const switchCompletions = [];
const switchCancellations = [];
const presentationStartUs = 650638n;
const simulatedForwardBufferUs = 8000000n;
const fallbackTriggerUs = 430000000n;
const minimumRestoreObservationUs = 460000000n;
let selected = false;
let configured = false;
let fallbackRequested = false;
let videoFrontierUs = 0n;

let demuxer;
demuxer = new module.TlvDemuxer({
  onTrack(track) {
    tracks.set(track.packetId, track);
    const preferredVideo = tracks.get(0xf300);
    const preferredAudio = tracks.get(0xf310);
    const rainfallVideo = tracks.get(0xf301);
    const rainfallAudio = tracks.get(0xf314);
    if (!selected && preferredVideo && preferredAudio) {
      demuxer.selectTrack('video', preferredVideo.trackId);
      demuxer.selectTrack('audio', preferredAudio.trackId);
      selected = true;
    }
    if (!configured && selected && preferredVideo && preferredAudio &&
        rainfallVideo && rainfallAudio) {
      demuxer.configureAutomaticLayerSwitch(
        preferredVideo.trackId, preferredAudio.trackId,
        rainfallVideo.trackId, rainfallAudio.trackId,
      );
      configured = true;
    }
  },
  onMseSegment(segment) {
    if (segment.type !== 'video') return;
    const endUs = BigInt(segment.endTimeUs);
    if (endUs > videoFrontierUs) videoFrontierUs = endUs;
  },
  onMseLayerSwitchStarted(event) { switchStarts.push(event); },
  onMseLayerSwitch(event) { switchCompletions.push(event); },
  onMseLayerSwitchCancelled(event) { switchCancellations.push(event); },
  onError(error) {
    if (!error.recoverable) throw new Error(error.message);
  },
});

const input = await open(resolve(samplePathArgument), 'r');
const chunk = new Uint8Array(2 * 1024 * 1024);
let position = 0;
try {
  demuxer.setMseTimestampOffset(-presentationStartUs);
  for (;;) {
    const mediaPlayheadUs = videoFrontierUs > presentationStartUs + simulatedForwardBufferUs
      ? videoFrontierUs - presentationStartUs - simulatedForwardBufferUs : 0n;
    demuxer.setMsePlaybackPosition(mediaPlayheadUs);
    const {bytesRead} = await input.read(chunk, 0, chunk.byteLength, position);
    assert.ok(bytesRead > 0,
      'authoritative recording reached EOF before rainfall-to-preferred restoration');
    position += bytesRead;
    assert.equal(demuxer.push(chunk.subarray(0, bytesRead)), true);
    const preferredVideo = tracks.get(0xf300);
    const preferredAudio = tracks.get(0xf310);
    const rainfallVideo = tracks.get(0xf301);
    const rainfallAudio = tracks.get(0xf314);
    if (!fallbackRequested && videoFrontierUs >= fallbackTriggerUs &&
        preferredVideo && preferredAudio && rainfallVideo && rainfallAudio) {
      demuxer.clearAutomaticLayerSwitch();
      demuxer.configureAutomaticLayerSwitch(
        preferredVideo.trackId, preferredAudio.trackId,
        rainfallVideo.trackId, rainfallAudio.trackId,
      );
      assert.equal(demuxer.switchLayer(
        rainfallVideo.trackId, rainfallAudio.trackId,
        presentationStartUs + mediaPlayheadUs,
      ), true, 'authoritative recording rejected its prepared rainfall layer');
      fallbackRequested = true;
    }
    if (fallbackRequested && preferredVideo && switchCompletions.some(event =>
      event.videoTrackId === preferredVideo.trackId)) break;
    assert.ok(videoFrontierUs < minimumRestoreObservationUs,
      `preferred layer never restored with an 8-second playback buffer: ${JSON.stringify({
        position, mediaPlayheadUs, videoFrontierUs, switchStarts,
        switchCompletions, switchCancellations,
      }, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
  }

  const preferredVideo = tracks.get(0xf300);
  const rainfallVideo = tracks.get(0xf301);
  assert.equal(configured, true, 'automatic preferred/rainfall pair was not configured');
  assert.equal(fallbackRequested, true, 'test did not enter rainfall playback');
  assert.equal(switchCompletions[0]?.videoTrackId, rainfallVideo.trackId,
    'recording did not begin on its usable rainfall layer');
  assert.equal(switchCompletions[1]?.videoTrackId, preferredVideo.trackId,
    'healthy preferred layer did not replace rainfall playback');
  assert.deepEqual(switchCancellations, [], 'automatic round trip was cancelled');
  assert.ok(BigInt(switchCompletions[1].videoPresentationTimeUs) >=
      videoFrontierUs - simulatedForwardBufferUs,
  'preferred restoration selected media behind the real playback position');

  console.log(JSON.stringify({
    bytesRead: position,
    videoFrontierUs: videoFrontierUs.toString(),
    simulatedMediaPlayheadUs: (videoFrontierUs - presentationStartUs -
      simulatedForwardBufferUs).toString(),
    switchStarts,
    switchCompletions,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} finally {
  await input.close();
  demuxer.delete();
}
