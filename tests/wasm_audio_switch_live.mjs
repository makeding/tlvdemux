import assert from 'node:assert/strict';

const [modulePath, sourceUrl, targetPacketIdText] = process.argv.slice(2);
assert.ok(modulePath && sourceUrl,
  'usage: node tests/wasm_audio_switch_live.mjs DIST_JS LIVE_URL');

const createModule = (await import(new URL(modulePath, `file://${process.cwd()}/`))).default;
const module = await createModule();
const audioTracks = [];
const events = [];
const failures = [];
let selectedAudio = null;
let latestAudioEndUs = null;
let splice = null;
let replacementSegment = null;
let switchResult = null;
let switched = false;
const targetPacketId = targetPacketIdText === undefined ? null : Number(targetPacketIdText);
assert.ok(targetPacketId === null || Number.isInteger(targetPacketId),
  'target packet ID must be an integer such as 0xf314');

const demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    if (track.kind === 'video' && !events.includes('selected-video')) {
      events.push('selected-video');
      demuxer.selectTrack('video', track.trackId);
    }
    if (track.kind !== 'audio' || Number(track.audio?.channels || 0) > 6) return;
    if (!audioTracks.some(item => item.trackId === track.trackId)) audioTracks.push(track);
    if (selectedAudio === null) {
      selectedAudio = track.trackId;
      demuxer.selectTrack('audio', track.trackId);
    }
  },
  onMseInit(init) {
    events.push(`init:${init.type}`);
  },
  onMseSegment(segment) {
    events.push(`segment:${segment.type}`);
    if (segment.type !== 'audio') return;
    assert.ok(events.includes('init:audio'), 'audio media arrived before its init segment');
    latestAudioEndUs = segment.endTimeUs;
    if (switched && replacementSegment === null) replacementSegment = segment;
  },
  onMseAudioSplice(value) {
    events.push('splice');
    splice = value;
    switched = true;
  },
  onError(error) {
    if (!error.recoverable) failures.push(error);
  },
});
demuxer.setMseOutputEnabled(true);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
let received = 0;
try {
  const response = await fetch(sourceUrl, {signal: controller.signal});
  assert.ok(response.ok && response.body, `live fetch failed: HTTP ${response.status}`);
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    assert.equal(demuxer.push(chunk), true, 'demuxer rejected a live chunk');
    const target = targetPacketId === null
      ? audioTracks[1] : audioTracks.find(track => track.packetId === targetPacketId);
    if (!switched && target && latestAudioEndUs !== null) {
      const earliest = latestAudioEndUs > 500000n ? latestAudioEndUs - 500000n : 0n;
      switchResult = demuxer.switchAudioTrack(target.trackId, earliest);
    }
    if (splice && replacementSegment) break;
    assert.ok(received < 256 * 1024 * 1024, 'switch was not observed within 256 MiB');
  }
} finally {
  clearTimeout(timeout);
  controller.abort();
  demuxer.delete();
}

assert.deepEqual(failures, [], 'the demuxer reported a fatal error');
assert.ok(audioTracks.length >= 2, 'the live stream did not expose two supported audio tracks');
assert.notEqual(switchResult, null, 'the alternate audio history did not cover the switch point');
assert.equal(splice.presentationTimeUs, switchResult,
  'the callback and returned audio splice boundaries differ');
const spliceIndex = events.indexOf('splice');
assert.equal(events[spliceIndex + 1], 'init:audio',
  'replacement audio init did not immediately follow the splice');
assert.equal(replacementSegment.startTimeUs, splice.presentationTimeUs,
  'replacement media does not begin at the announced splice');

console.log(JSON.stringify({
  received,
  audioTracks: audioTracks.map(track => ({
    packetId: track.packetId,
    trackId: String(track.trackId),
    channels: track.audio?.channels,
    sampleRate: track.audio?.sampleRate,
  })),
  switchBoundaryUs: String(switchResult),
  replacementStartUs: String(replacementSegment.startTimeUs),
  eventTail: events.slice(-12),
}, null, 2));
