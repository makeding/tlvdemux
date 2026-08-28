import assert from 'node:assert/strict';
import {
  preferredCaptionTrack,
  shouldRenderSubtitleTrack,
  subtitleTrackKind,
} from '../track-selection.mjs';

const caption = {trackId: 1n, packetId: 0xf330, subtitle: {type: 0}};
const alternateCaption = {trackId: 2n, packetId: 0xf331, subtitle: {type: 0}};
const superimpose = {trackId: 3n, packetId: 0xf338, subtitle: {type: 1}};

assert.equal(subtitleTrackKind(caption), 'caption');
assert.equal(subtitleTrackKind(superimpose), 'superimpose');
assert.throws(() => subtitleTrackKind({packetId: 0xf339, subtitle: {}}),
  /invalid subtitle\.type/);
assert.equal(preferredCaptionTrack([superimpose, caption, alternateCaption]), caption);
assert.equal(preferredCaptionTrack([caption, alternateCaption], 0xf331), alternateCaption);
assert.equal(shouldRenderSubtitleTrack(caption, caption.trackId), true);
assert.equal(shouldRenderSubtitleTrack(alternateCaption, caption.trackId), false);
assert.equal(shouldRenderSubtitleTrack(superimpose, caption.trackId), true);

console.log('subtitle track selection tests passed');
