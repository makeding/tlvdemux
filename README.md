# tlvdemux

English | [日本語](README.ja.md)

`tlvdemux` is the C++20 playback, fMP4/MSE and WASM integration layer for
already-descrambled ARIB MMT/TLV streams. Its protocol parser and data-broadcast
resource core is [libaribtlv](https://github.com/makeding/libaribtlv);
`tlvdemux` keeps player-ready HEVC, AAC-LATM/LOAS and ARIB STD-B62 TTML delivery
without converting the stream to MPEG-TS or exposing FFmpeg ABI types.

The current implementation provides the stable public callback API, bounded
incremental TLV resynchronization, compressed-IP context isolation, MMTP
fragment/aggregation handling, PA/M2/MPT track discovery, descriptor-driven
timelines, and HEVC/AAC-LATM/TTML access-unit output.

## Build and test

```sh
nix-shell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

`libaribtlv` owns the protocol and Zlib dependency. By default CMake fetches its
HTTPS repository at the pinned revision
`6ecf9e3b1a8fd95563bc5071213b67b936ea01b3`. Point
`TLVDEMUX_LIBARIBTLV_SOURCE_DIR` at a local checkout for offline development, or
set `TLVDEMUX_USE_SYSTEM_LIBARIBTLV=ON` and add an installed package prefix to
`CMAKE_PREFIX_PATH`. The local source directory takes precedence over both.
With a source dependency, `BUILD_TESTING=ON` builds tlvdemux's integration tests
without importing libaribtlv's repository-internal test executables; those run
in libaribtlv's own CI.

Before a release, run the local captured-sample inventory gates in addition to
the unit suites:

```sh
npm run test:inventory-samples
npm run test:inventory-samples:hardware  # macOS VideoToolbox
```

The software gate requires every `.tlv`/`.mmts`/`.mmt` file in the repository
root and `demo/` to have an explicit manifest entry. For every registered sample
it verifies exact source identity, a duration probe capped at 16 MiB, a bounded
WASM/MSE playback entry, and a complete WASM/index scan. It also runs the
subtitle, layer-selection, manual-to-automatic, rainfall startup/full-sample,
and 60/200/380-second seek contracts on their owning samples. The macOS gate
hardware-decodes every sample through the native MSE/VideoToolbox probe, runs
the complete rainfall fallback, and repeats the deterministic sixteen-landings
`8k.mmts` seek probe. Adding or replacing a captured sample without assigning
these regressions is a release-gate failure; these large local captures remain
outside the ordinary package `npm test`.

Shared-library builds are enabled by default. Linux produces
`libtlvdemux.so.0` (with the versioned implementation file), while macOS
produces the corresponding `libtlvdemux.0.dylib`. Use
`-DBUILD_SHARED_LIBS=OFF` when a static `libtlvdemux.a` is preferred.
The exported interface is a C++20 ABI, so dynamically linked consumers should
use a compatible compiler and C++ standard library.

When embedding the project with `add_subdirectory()`, the command-line executable
can be disabled with `-DTLVDEMUX_BUILD_TOOLS=OFF`. Tests follow CMake's standard
`BUILD_TESTING` option.

Tagged GitHub releases provide one standalone executable for each supported
platform, named `tlvdemux-PLATFORM-ARCH` (with `.exe` on Windows). Rename the
download to `tlvdemux` and, on Unix, mark it executable. It exposes the
user-facing tools as subcommands:

```sh
tlvdemux --help
tlvdemux probe recording.mmts
tlvdemux inspect --list recording.mmts
```

This unified executable replaces the previously installed `tlvdemux-pipe`,
`tlvdemux-probe`, `tlvdemux-inspect`, `tlvdemux-extract`, and `tlvanalyze`
programs. Existing scripts should insert the corresponding subcommand after
`tlvdemux`.

On macOS, the VideoToolbox probe exercises the native part of the browser-facing
MSE path without launching a browser. It feeds MMTS through the production
`MseRemuxer`, applies Chromium-compatible coded-frame discontinuity and random
access rules, validates `tfdt`/`trun` continuity and HEVC sample flags, and
submits the result to hardware VideoToolbox decoding. `SourceBuffer` rendering
is a separate integration surface; the direct-rainfall recovery contract below
is accepted without launching or automating a browser.

This command covers automatic 4K-to-rainfall video/audio fallback on the edge
sample:

```sh
./build/tlvdemux-videotoolbox-probe \
  demo/rain.tlv \
  --mse --video-packet-id 0xf300 --audio-packet-id 0xf310 \
  --fallback-video-packet-id 0xf301 --fallback-audio-packet-id 0xf314 \
  --expect-rainfall-init --max-au 30000 --inflight 8
```

The following repeats a run at sixteen deterministic random byte landings
while pacing samples at 3x:

This developer probe is available in source builds and is not included in the
standalone release executable.

```sh
./build/tlvdemux-videotoolbox-probe demo/8k.mmts \
  --mse --rate 3 --inflight 4 --max-au 90 \
  --random-seeks 16 --seed 20260731
```

Install the library, public headers and CMake target export with:

```sh
cmake --install build --prefix /desired/prefix
```

The install includes the playback/MSE library, public headers, the
`tlvdemux::tlvdemux` CMake package target, the `tlvdemux` executable when enabled,
and the MIT license. Its CMake package requires an installed `aribtlv` package.

`MseRemuxer` tracks the preferred and rainfall A/V layers independently from
their continuous DTS, observed RAPs, usable AAC, and explicit source-damage
spans. Automatic playback has only two modes: preferred or rainfall. If the
active layer is damaged, the core starts a same-timeline switch when the other
layer already has aligned decodable video and audio. Otherwise it emits
`PlaybackDamage` for the active layer. A recovered span shorter than the
two-second severe threshold with an explicit recovery RAP is a `warning` with
action `seek-if-stalled`: parser prefetch only arms that recovery and never
moves the media clock. A severe recovered span remains `severe` with action
`seek`, while a span without a recovery RAP remains `wait-for-recovery` until a
real RAP arrives. Damage is never retained until EOF and never inferred across
an unobserved interval.
Emergency preferred-to-rainfall switching also covers startup. If the selected
preferred layer has not produced a decodable MSE video entry while the rainfall
layer has a real RAP, a following continuous video DTS, continuous AAC, and an
aligned A/V boundary, the core switches immediately with reason
`health-degradation`. It requests the current playback entry (timestamp zero for
a fresh recording), so cached target history starts at the earliest usable
rainfall RAP instead of the last observed RAP. It does not wait for a preferred
damage event or the five-second health baseline; that baseline applies only
while rainfall playback is healthy and is being considered for an automatic
return to the preferred layer.
While rainfall playback is active, the preferred tracker keeps warming and may
switch back after five continuous decodable seconds with aligned RAP/AAC at the
actual caller-reported playback position. Parser or recording-index progress is
never a playback clock: reading healthy preferred media hundreds of seconds
ahead must not replace rainfall media at a playhead that is still at timestamp
zero. Until a playback position is reported, automatic rainfall-to-preferred
recovery remains armed but cannot commit.
The normal 8-to-15-second recorded forward buffer is not such unrelated parser
progress. A preferred RAP aligned with AAC between the actual playhead and the
20-second bounded observation frontier is a valid future splice; requiring it
to fall within two seconds of the playhead makes rainfall restoration
impossible under normal flow control. The authoritative
`20260828-101-180000_4c9f94c3-6ed1-455f-9fee-fcfa8c062de0.mmts` regression keeps
the parser eight seconds ahead and must complete rainfall-to-preferred
restoration before source presentation time 460 seconds. It must also retain
exact common A/V seek coverage at displayed time 11:37 (697 seconds) and at the
near-boundary 820-second target within the shared 16 MiB budget. A one-second
grid through the sample's common A/V interval, media times 1 through 1573
seconds inclusive, must satisfy that same exact-target and budget contract.
Damage on the rainfall layer follows the same rule in the opposite direction.

`onMseLayerSwitchStarted`, `onMseLayerSwitch`, and
`onMseLayerSwitchCancelled` describe the one-shot A/V splice staging; they do
not form a separate recovery state machine. SourceBuffer mutations use one
ordered queue: remove, timestamp offset, `changeType`, initialization segment,
then media. Every configuration splice on an existing SourceBuffer records the
affected audio or video track independently, and the next corresponding init
must call `changeType()` even when the MIME string is unchanged. Layer switches
therefore reconfigure both tracks, while in-content AAC channel-layout and HEVC
SPS/color-configuration changes reconfigure only the affected track.
The 82,837,220-byte `demo/mpegts` regression is an in-content SDR-to-HDR
transition on video packet `0xf300`, not evidence that the selected layer is
damaged. Playback must remain on `0xf300`; it must never select the rainfall
packet `0xf301` while installing the new `0xf300` decoder/color configuration.
The same boundary also changes the selected `0xf310` AAC layout from 6 channels
to 2 channels. Both changes must continue through the existing SourceBuffers
without a rainfall-layer switch or a persistent `waiting` at `16.168s`.
For an audio splice, `timestampOffsetUs` is the complete absolute
`SourceBuffer.timestampOffset`, never a relative adjustment. In the cold-start
`demo/sdr-hdr.tlv` regression, fresh entry alignment first installs
`-650638us`; the AAC configuration change at source `16938688us` then replaces
it with `-714638us`, mapping both the old audio end and replacement audio start
to `16224050us`. That content transition must stay on video packet `0xf300`,
must not trigger a layer switch or recovery seek, and must not be concealed by
selecting the rainfall layer.
A bare
MediaElement `waiting` event or a later buffered range never authorizes a seek.
Only `PlaybackDamage.action === "seek"` for the currently playing layer may
reposition directly; `seek-if-stalled` is retained as authorization and may be
executed only by a causally matching `waiting`; a late event may use the next
buffered parser-observed RAP at or after its current media clock. Explicit PID
or concrete track selection remains fixed mode and disables automatic layer
decisions.
At the first usable target RAP, both tracks are logically spliced at that boundary:
already-appended old-layer audio after it is removed, and replacement AAC is
mapped to the same boundary within one 22 ms AAC frame. Old buffered audio must
never postpone the video switch to a later RAP. A startup switch can precede
creation of the preferred video SourceBuffer: its staged order is still logical
video splice -> rainfall init -> rainfall media, and the absent SourceBuffer is
not removed. A discarded staging attempt rebuilds that complete order, including
the target init even when the MIME string is unchanged.

For a fresh recorded playback at timestamp zero, startup and buffered-range
handling must not assign `MediaElement.currentTime`. Only an explicit user seek,
a selected-layer `PlaybackDamage.action === "seek"` after switching was
unavailable, a matching `waiting` authorized by `seek-if-stalled` and actual
presented-frame evidence, or the existing live-start policy may change the
playback position.
The demo reports that unchanged media clock to the core for recovery decisions;
this is observation, not a seek.

Before a fresh recorded SourceBuffer pair is created, the demo enables atomic
entry alignment in `createMseOutputPipeline()`. The pipeline stages both init
segments and their first media segments until it finds the earliest common A/V
source interval, assigns both SourceBuffers the same negative `timestampOffset`
that maps that interval's start to timestamp zero, and then commits each queue in
timestamp-offset -> init -> media order. An explicit staged splice offset, such
as a rainfall-layer startup mapping, always takes precedence: entry alignment
must neither derive another offset nor add one to the splice mapping. Live,
explicit-seek, and reused-MediaSource paths do not enable this fresh-entry mode.
The presence of two later, not-yet-mapped track ranges is therefore not an
immediate `MSE_STARTUP_NO_COMMON_AV`; fresh startup fails only when no common A/V
entry can be formed within the existing 16 MiB input budget.
When the first usable rainfall RAP is later than that fresh playback entry, the
splice retains the RAP's source presentation time and carries a negative MSE
timestamp offset that maps the replacement A/V output onto timestamp zero. The
demo applies that offset in the same SourceBuffer mutation queue before the
replacement init and media. It applies input backpressure from the common A/V
buffered interval, not parser progress: requests stop at 15 seconds ahead and
resume below 8 seconds. Before any common interval covers the playback entry,
at most 16 MiB of playback input may be read without progress; exhaustion fails
with `MSE_STARTUP_NO_COMMON_AV` instead of fetching the recording to EOF.

Live playback has no timestamp-zero entry. Its startup entry is the first common
A/V buffered interval produced by the current stream, and the media clock is
aligned to that interval only after the configured live startup buffer is ready.
Flow control must accept and measure that later interval before the alignment
write occurs; it must never classify valid live A/V merely because the interval
does not cover timestamp zero. If live A/V cannot form any common interval, the
same 16 MiB no-progress limit still stops input with
`MSE_STARTUP_NO_COMMON_AV`.

An explicit recorded seek is a separate public playback-entry contract. From
head discovery through every RAP probe and the final A/V preroll,
`createMseRecordedSeekSession()` shares one hard 16 MiB source-read budget.
From the first explicit-seek intent until exact selected-video and selected-audio
coverage has been appended and committed, that seek owns the demux/MSE
transaction. Automatic layer switching is fenced for the complete probe,
landing, append, and commit interval: an already pending switch is cancelled,
new health or damage observations may warm the same preferred/rainfall trackers
but cannot start, complete, or resume an automatic switch, and automatic mode is
reevaluated only after the exact target is committed. The seek may choose a RAP
and matching AAC from either member of the automatic pair as its landing source;
that choice is part of the explicit seek and is not an automatic layer switch.
It must still preserve the requested `MediaElement.currentTime`, perform one
formal landing, share the single 16 MiB budget, and never map a nonzero seek back
to playback entry zero.
The monotonic playback-intent token and its single destructive commit lane are
owned by the public `tlvdemux/mse-playback` SDK, not by the demo. Integrations
create tokens for explicit seeks, layer switches, and recovery candidates and
must validate the token and fixed demux identity around every asynchronous read
or commit. The demo only forwards browser events and installs the SDK-approved
result.
Overlapping probe and landing ranges are reused, and no source request is issued
after exhaustion. Head discovery, probes, and landing use 1 MiB reads so a
single coarse read cannot consume one eighth of that shared budget before the
stable recovery RAP is reached. A RAP before the requested media time is valid
preroll: seek continues until the common buffered A/V interval covers the requested time,
then normal 15-second/8-second backpressure resumes. The probe records RAPs only
through target + 50 ms. It stops as soon as it observes a RAP not later than
the target within the two-second preroll window; otherwise it stops when the
observed candidate frontiers pass the target. It selects the closest acceptable
observed RAP not later than the target without waiting for an unobserved layer.
Probe interpolation seeds its earlier anchor from the public
union start at source offset zero, then retains the closest observations before
and after the target instead of an access-unit history whose anchors can age
out. Each candidate reads at most one two-second probe window before the next
interpolation, and observed RAPs remain eligible across those candidates. This
prevents a variable-bitrate estimate on the wrong side of the target from
turning into an unbounded sequential scan. If one side is still unavailable,
the next bounded probe moves backward by one probe window. It must not bisect
toward the file head and spend the shared budget in an unrelated earlier
interval. An A/V landing requires its
chosen RAP to precede the target by at least one second; a closer RAP triggers one
bounded earlier probe so AAC begins before the exact target. The recording's
earliest available RAP is the only exception when no earlier input exists. At
the formal landing, the sole reposition uses that RAP's safe restart offset.
Before the sequential landing input, the session gives the HEVC remuxer the
original source target as a one-shot recorded-seek concealment target. It remains
armed across out-of-PTS-order input
until exact entry coverage succeeds or the landing fails, then the session
explicitly clears it. No second reposition occurs. If that target
lies in a selected-video source-damage episode, the
remuxer fills only that hole with a still picture after the existing stable-GOP
check: it extends the last complete pre-damage sample to the stable RAP decode
boundary, or, when landing contains no earlier picture, duplicates the stable
RAP first frame at the target while retaining the original RAP at its original
DTS/PTS. AAC remains on its original continuous timeline. This fill never moves
`MediaElement.currentTime`, performs another landing seek, rescans the source,
or increases the shared 16 MiB budget. Later-only or otherwise disjoint raw A/V
is therefore valid when the fill creates common coverage at the exact target.
No usable pre-damage frame and no stable following RAP, no RAP, EOF, remaining
disjoint A/V, or budget exhaustion fails with `MSE_SEEK_NO_COMMON_AV` and stops
reading. It must never be reported as `MSE_STARTUP_NO_COMMON_AV`, cause a hidden
media-element seek, or fall back to scanning the complete recording.

For automatic dual-video recordings, the public recorded timeline is the union
of the preferred and rainfall video presentation ranges. The recording start is
the earlier first video frame, the recording end is the later last video frame
including that track's inferred final-frame duration, and public duration is
`end - start`. Media time zero maps to that union start; the other video layer
keeps its original offset from the same origin. Duration display,
`MediaSource.duration`, fresh startup, explicit recorded seek, selected-layer
damage recovery, and MSE timestamp offsets must all use this one mapping. An
explicit `videoPacketId` intentionally restricts the range to that single video
track instead of forming the automatic pair's union.

Selected-layer automatic recovery remains distinct from an explicit recorded
seek. A current-layer severe `PlaybackDamage.action === "seek"` with a concrete
recovery timestamp may move the media clock exactly once using the same
union-origin mapping. A short recovered `warning` uses `seek-if-stalled`: it is
registered without moving the clock and may execute at most once per causal
`waiting` after the media clock has reached that damage. `MediaElement.currentTime`
and `playing` are not proof that damaged video decoded: audio may advance the
media clock beyond the first recovery RAP while the visible frame remains
stalled. The SDK therefore tracks compositor-presented video PTS through
`requestVideoFrameCallback()`. A presented frame at or beyond the first recovery
RAP retires the authorization; otherwise a late `waiting` selects the earliest
parser-observed RAP at or after the current media clock that is already buffered.
If that RAP has not arrived or been appended yet, the authorization remains
armed until access-unit or SourceBuffer progress makes it usable. This recovery
must always move forward; it must never jump backward to an already-passed RAP.
This state machine is part of the public `tlvdemux/mse-playback` SDK; the demo
only supplies its media/layer callbacks and forwards parser RAPs, `waiting`, and
SourceBuffer progress. Browsers without presented-frame callbacks use the safe
legacy subset and may recover only while the media clock has not passed the
first recovery RAP. Neither recovery path may restart duration probing, scan the
source, or run concurrently with an A/V layer switch. A buffered range without
a parser-observed RAP, damage on an inactive layer, ordinary `waiting`, and
`wait-for-recovery` never authorize a seek.

When the selected video remains unpresentable after three different,
strictly-forward, parser-observed recovery RAP attempts, the public playback
resilience controller enters `audio-only` with the stable code
`TLV_VIDEO_UNAVAILABLE`. This is a fourth playback mode beside
`audio-video`, `recovering-video`, and `restoring-video`; it does not change
`PlaybackDamage.action` or its severity thresholds. A current-layer damage
authorization, a causal `waiting` after each attempted RAP, and the absence of
a newly presented video frame are all required. Ordinary waiting, a paused
MediaElement, an explicit seek, a layer/audio-track switch, stale generation,
or damage on an inactive video track must never enter audio-only playback.
The integration explicitly forwards the visible MediaElement's `pause` and
`play` lifecycle through `notifyPlaybackPaused()` and
`notifyPlaybackResumed()`. A pause freezes waiting consumption, recovery-RAP
attempts, audio-only decisions, and restore commits without clearing the current
damage episode, stable RAP, or prior attempts. Resume only removes that freeze:
recovery may continue after a new causal `waiting` event or a newly presented
video frame, never from a waiting or buffer event retained across the pause. No
damage-recovery path may call `play()` on the visible MediaElement.

Audio-only playback changes the MSE required-track set to audio, so startup,
buffer coverage, backpressure, and recorded-seek landing do not wait for the
video SourceBuffer. Inactive video output is discarded immediately and never
forms an unbounded transition cache. A runtime in-place switch is accepted only
after the video SourceBuffer is actually absent from `activeSourceBuffers`;
otherwise the integration must build a fresh audio-only MediaSource. Recorded
rebuilds reuse the public index/seek session and its single 16 MiB read budget.
They are resource transactions: the old MediaSource remains attached with its
current audio, media clock, and user play/pause intent while a bounded hidden
candidate is built from the cached duration/index. Only a fully buffered
audio-only candidate, or an A/V candidate whose restore RAP was actually
presented, may be promoted. Pause may retain candidate buffers but forbids
candidate playback and commit. Any open, format, seek, append, or decode failure
discards only the candidate; it must not detach, stop, seek, or otherwise mutate
the old MediaSource.
Live integrations retain bounded current input while the replacement audio
pipeline becomes playable; they must not reconnect or stop feeding the existing
audio pipeline. The audio clock remains authoritative throughout the transition.
`createLiveMseTransitionManager()` owns the 4 MiB candidate MediaSource queue,
receives the same ongoing demux output as the active pipeline, and commits a
restored A/V candidate only after its hidden probe MediaElement reports the
target frame through `requestVideoFrameCallback()`. Commit promotes that still-attached
candidate MediaElement; detaching and reattaching its object URL is forbidden because
the MSE detach algorithm empties both SourceBuffer lists.

While audio-only playback continues, each real RAP strictly after the audio
clock is eligible for one restore attempt. Restoration stays in
`restoring-video` until a common A/V candidate is buffered and
`requestVideoFrameCallback()` proves a frame at or after that RAP was actually
presented. A failed candidate leaves the current audio playback untouched and
returns to `audio-only` to await a later RAP; it must not seek backward, repeat a
RAP, or call `play()` over a user pause. Explicit seek, track/layer selection,
generation replacement, and source end cancel the transition. The demo renders
these structured SDK modes in a fixed video-stage slot and shows
“映像を復旧できないため、音声のみ再生しています。利用可能になり次第、自動的に戻ります。
[TLV_VIDEO_UNAVAILABLE]” without exposing retry counts or timers.

Recoverable AAC source-damage markers must not discard already queued audio or
restart the selected audio fragment timeline. Missing AAC frames are compacted
onto the next 1024-sample boundary so subsequent fragments remain contiguous;
otherwise Chromium reports `DEMUXER_UNDERFLOW` while video is buffered and the
common A/V buffer remains near zero. The captured
`20260828-101-021500_8deb3dd2-39e9-471c-a9ba-a6dfe23feeb6.mmts` regression must
advance audio buffering despite repeated audio discontinuity markers.

The Worker client treats every public `Uint8Array` input as caller-owned.
`TlvDemuxer.push()`, duration-probe `pushRange()`, and `setMseEdid()` transfer an
SDK-owned copy and must never detach the caller's `ArrayBuffer`. In particular,
an explicit seek may reuse cached source bytes across probe and landing without
throwing a detached-`ArrayBuffer` error or initiating another seek.

The `rain.tlv` validation contract requires its first automatic switch at the
earliest rainfall RAP (currently about `821944us`), before any preferred-layer
init, the later approximately 46-second preferred damage event, or any seek. The
source switch boundary remains `821944us`, while its startup timestamp offset
maps the first common MSE A/V interval to timestamp zero. The first target init
must be `1920x1080/L123`, the full WASM run must contain no
`PlaybackDamage.seek`, and the switch A/V boundaries must differ by at most one
22 ms AAC frame. Startup flow-control acceptance must reach that common interval
without consuming more than the 16 MiB no-progress budget and must stop normal
prefetch at the 15-second high-water mark rather than reading the 711 MiB sample
to EOF. The previously observed switch around 0:48 and its `-12909` are the
failure being corrected, not an acceptable switch point. Automated
acceptance uses the native VideoToolbox MSE probe plus the full-sample WASM
assertions; it must not invoke browser automation or ask a user to be the
runtime tester.

The captured single-layer sample
`20260828-141-020000_99332dc9-025e-4e76-afc4-e31c3d577059.mmts` is exactly
`1792861104` bytes and `496.913089` seconds. It contains only video packet
`0xa140` and audio packet `0xa141`, with no rainfall fallback. Its full-sample
regression must expose short selected-video damage as `seek-if-stalled` with the
complete source span, input offsets, and a real recovery RAP. Parser prefetch
must not seek. The observed browser boundary is a `waiting` near `6.580s` after
the first mapped recovery RAP at `6.272934s`, while the visible video frame has
not recovered. The SDK must select the next parser-observed forward RAP at
`6.806806s`, seek there exactly once after it is buffered, and continue. A stale
or unrelated `waiting` must not seek forward or backward. Real-browser
acceptance must also exercise the current demo with this sample and show that
natural late stall recovery, continuing without a rainfall switch, MediaSource
rebuild, recorded-seek session, or whole-source reread.

Assigning `MediaElement.currentTime` to a recovery RAP does not complete a short
damage recovery. The authorization remains armed until the compositor presents
a frame at or beyond its first recovery RAP. Each subsequent causally matching
`waiting` may consume at most one strictly later parser-observed, buffered RAP;
parser or SourceBuffer progress alone must not ladder through recovery points.
The observed second boundary in this sample is `waiting` at `13.245s`, a first
attempt at `13.747079s`, and another `waiting` at `13.747s` while the last
presented video frame remains `7.291s`. That second event must retain the same
damage authorization and advance to the next real RAP at `14.280934s`, never
repeat `13.747079s`. Only an actually presented recovery frame completes the
authorization and prevents later unrelated `waiting` events from seeking.
The same sample's observed `waiting` at media time `101.810s` is deliberately
ordinary waiting: there is no selected-video damage at that clock. Damage
already discovered by parser prefetch starts at mapped media time `114.097s`
and recovers at the real RAP `115.315189s`; it remains retained for that future
boundary and must not authorize a seek or audio-only transition at `101.810s`.
Demo diagnostics label these mapped values as playback time and explicitly mark
future damage as prefetched instead of printing source PTS beside the current
MediaElement clock.
The same rule applies while the MediaElement still reports `seeking` for the
SDK-owned recovery target: the observed `6.589s -> 6.806806s -> 7.340679s`
attempts can produce another causal `waiting` at `7.341s` before `seeked`.
Because that clock still matches the last SDK attempt and presented video is
still behind the first recovery RAP, the event must advance to the next real
RAP at `7.874540s`. A `seeking` state at any unrelated target remains blocked.
An authorized recovery seek only writes the recovery target. It never calls
`play()` on the visible MediaElement; the browser's existing playback intent
continues to own play/pause. A genuinely user-paused element, or ordinary
`waiting` without a matching selected-video damage authorization, must never
start playback.

Recovery also requires decodable MSE media after the damage boundary. A
selected-video source-damage marker seals and emits every complete valid video
sample before the loss and retains the existing source timeline mapping. The
first real RAP then opens a bounded observation period: its GOP is discarded,
another source-damage marker vetoes it, and video output resumes only at the
next real RAP after one complete damage-free GOP. No candidate GOP is cached.
In the authoritative sample, the `99.201500–99.351650s` and
`99.468433–99.485117s` islands must not be emitted; stable output resumes at
source PTS `100.269228s` while AAC remains continuous. Startup, explicit seek,
track/layer switching, and undamaged input still start at their first RAP.
The observation period is armed only after the selected-video generation has
already accepted media. A source-damage marker at fresh startup, including one
carried by the first RAP, must therefore start at that first real RAP without
waiting for another clean GOP; it must form the initial common A/V entry within
the same 16 MiB no-progress budget.

Manual-to-automatic layer selection is an active transition, not only a policy
flag. If the user has manually selected the rainfall layer, enabling automatic
selection must reactivate the preserved preferred/fallback health observations
and immediately stage a coordinated return to healthy preferred video and its
corresponding audio at the next usable RAP. An unavailable or damaged preferred
layer keeps the usable rainfall output instead of leaving a switch pending to
EOF. Re-enabling automatic mode also supersedes an unfinished manual request.
A manual layer selection made before the initial common A/V entry is established
maps both replacement tracks to that playback entry; its normal preroll must not
be misreported as `MSE_STARTUP_NO_COMMON_AV`.

## Library usage

The staged plan for moving the remaining shared browser playback behavior into
the public SDK is documented in [Browser playback SDK convergence plan](docs/browser-sdk-roadmap.md).

Browser integrations import the recorded-seek coordinator instead of copying
demo probe logic:

```js
import {createMsePlaybackFlowControl, createMseRecordedSeekSession}
  from 'tlvdemux/mse-playback';

const flowControl = createMsePlaybackFlowControl({
  media, queues, entryKind: 'seek', entryTimeSeconds: targetSeconds,
});
const seek = createMseRecordedSeekSession({
  targetTimeSeconds: targetSeconds,
  source, durationUs, demuxer, media, queues, flowControl,
  headReady: () => selectedVideo !== null,
});
callbacks.onTrack = track => seek.observeTrack(track);
callbacks.onTrackRemoved = track => seek.observeTrackRemoved(track);
callbacks.onAccessUnit = unit => seek.observeAccessUnit(unit);
const {nextOffset} = await seek.run();
```

The coordinator accepts synchronous native-WASM methods and Promise-returning
worker wrappers, so a DPlayer adapter can use the same lifecycle.

Implement `aribtlv::Sink`, keep it alive for the lifetime of the demuxer, and
feed arbitrary-sized chunks synchronously:

```cpp
#include <aribtlv/demuxer.hpp>

class PlayerSink final : public aribtlv::Sink {
public:
    void onService(const aribtlv::ServiceInfo& service) override;
    void onTrack(const aribtlv::TrackInfo& track) override;
    void onAccessUnit(aribtlv::AccessUnit&& unit) override;
    void onError(const aribtlv::Error& error) override;
};

PlayerSink sink;
aribtlv::Demuxer demuxer(sink);
demuxer.push(data, size);
demuxer.flush();
```

`push()` does not retain the input pointer. Callback payloads own their data,
and malformed stream data is reported through `onError()` while parsing
continues where recovery is possible. Call `reset()` when replacing the input
stream; service and track selection policies are retained.

Audio tracks expose their MH audio component metadata through
`TrackInfo::audio`, including the signalled channel layout, component type,
main-component flag and sampling rate. Select tracks from this metadata rather
than assuming packet IDs remain fixed between programmes.

### Demuxer lifecycle

Treat each demuxer instance as one logical input session. The important
boundaries are different operations rather than interchangeable ways to clear
the parser:

- `push()` accepts arbitrary chunk boundaries. Native callbacks and direct-WASM
  media/signalling callbacks run synchronously inside the call; callback-
  lifetime byte views must be consumed before it returns. Direct WASM queues
  application-resource assembly separately as described below.
- `flush()` closes the current contiguous input span. It emits complete buffered
  access units, reports and drops incomplete fragments, and makes any later
  media resume at a discontinuity (video waits for a RAP). It does not destroy
  the demuxer, clear discovered metadata, finalize a recording index, or call
  `MediaSource.endOfStream()`. Call it at a real EOF or intentional input
  boundary, not whenever a live network read is temporarily empty.
- `reposition(offset, true)` seeks within the same source. It preserves track
  selections and the normalized media timeline, uses `offset` as the new
  absolute input position, waits for a selected video RAP, and marks the first
  output from each track discontinuous. Pass `false` only when the new position
  should establish a new timeline origin. In the WASM wrapper, completed
  application VFS files survive a reposition while incomplete carousel
  assembly is discarded.
- `reset()` replaces the logical source. Parser, service/track catalogue,
  timeline, application resources, offsets and error counters are cleared, but
  explicit service/track selections and construction options are retained. An
  active WASM recording index is restarted empty. Clear or reselect retained
  track IDs if the replacement source uses different IDs.
- `selectService()` is a service-session change, not a media seek. It clears
  service-scoped tracks, timing and application resources; select new tracks
  from the subsequent `onTrack` callbacks.
- At permanent EOF, call `flush()`, then `finalizeIndex()` if indexing was
  enabled. Let asynchronous SourceBuffer/application consumers drain before
  ending MSE. WASM objects must finally be released with `delete()`; in native
  code the `Sink` must outlive the `Demuxer`.

### Browser MSE queue

Browser integrations can reuse the SourceBuffer state machine shipped by the
package instead of duplicating append, trim, retry and worker-backpressure
logic in each player:

```js
import {
  MseAppendQueue,
  finalizeMseMediaSource,
} from 'tlvdemux/mse-append-queue';

const videoQueue = new MseAppendQueue(mediaSource, video, videoMime);
videoQueue.append(initSegment);
videoQueue.append(mediaSegment);
await videoQueue.waitBelow(4 * 1024 * 1024);

await finalizeMseMediaSource(mediaSource, [videoQueue, audioQueue], {
  // Enable only when the demuxer reported an incomplete physical input tail.
  truncateToCommonEnd: incompleteInputTail,
});
```

The queue counts both pending and in-flight bytes, recomputes ownership after
every `updateend`, serializes `appendBuffer()` and `remove()`, retries Chromium
quota pressure, and rejects detached or failed SourceBuffers. The finalizer
waits for both tracks before `endOfStream()`; for a physically truncated input
it can first remove an unmatched A/V tail and finish on the last common coded
frame. It does not hide malformed-input errors or truncate complete recordings.

## Data-broadcast applications and virtual files

Application-resource collection is enabled by default. While media access units
are emitted, the demuxer also combines application signalling, data-directory
tables, asset-management tables and out-of-order data units into complete files.
`Sink` receives `onApplicationState`, `onApplicationResource`, and
`onApplicationResourcesReset` events. An application becomes `Ready` when its
AIT entry path is present; other referenced files may continue arriving from the
broadcast carousel.

Collection readiness and broadcast-requested application lifecycle are
independent. `state` describes virtual-file availability: `ready` means that
the entry document exists, not that every referenced resource has arrived or
that an HTML runtime is running. `lifecycle` maps the AIT `controlCode`:

| `controlCode` | Reported `lifecycle` | Receiver responsibility |
| --- | --- | --- |
| `0x01` AUTOSTART | `autostart-pending` until the entry exists, then `autostart-ready` | Start only after it is ready and receiver policy permits it. |
| `0x02` PRESENT | `present` | Make the application available for presentation; this is not proof that it was launched. |
| `0x04` KILL | `killed` | Stop any active runtime/session. Cached files may remain until a resource reset. |
| `0x05` PREFETCH | `prefetching` until the entry exists, then `prefetched` | Collect/cache resources without presenting the application. |
| any other value | `unsupported` | Do not infer a launch action. |

`tlvdemux` reports these transitions but never launches, reloads or terminates
the application runtime itself. The host owns that state machine, including
idempotent start/stop behavior, UI policy and the security boundary. In the
WASM API, `reset()` and `selectService()` clear the completed VFS and emit
`onApplicationResourcesReset`; `reposition()` deliberately retains completed
files. A `killed` application can therefore still have `state: "ready"` until
the host closes it or the resource session is reset.

Direct WASM callers must also drive application assembly explicitly. Call
`drainApplicationResources(maxEvents)` after input batches and schedule another
drain when it returns `true`; a value of `0` drains all events currently queued.
After `flush()`, drain until it returns `false` before reading the final VFS or
deleting the demuxer. The demo worker wrapper performs this scheduling
automatically so large carousel decompression cannot block media input.

Completed bytes are moved to the sink rather than retained indefinitely by the
demuxer. Native hosts can keep them in the thread-safe
`ApplicationResourceStore`, whose `get`, `list`, and `waitFor` methods are
intended for a loopback HTTP/WebView adapter:

```cpp
class ReceiverSink final : public aribtlv::Sink {
public:
    aribtlv::ApplicationResourceStore files;

    void onApplicationState(const aribtlv::ApplicationState& state) override {
        files.onApplicationState(state);
    }
    void onApplicationResource(aribtlv::ApplicationResource&& resource) override {
        files.onApplicationResource(std::move(resource));
    }
    void onApplicationResourcesReset() override {
        files.onApplicationResourcesReset();
    }
    // Implement the four required media/error callbacks as usual.
};
```

The store contains no socket or HTTP dependency. A native application may bind
a separate server to `127.0.0.1` and answer a request with
`files.waitFor(context_id, path, timeout)`. WASM callers normally keep the same
events in a JavaScript `Map` and expose them through a Service Worker instead.

Resource collection can be disabled with
`Limits::collect_application_resources`. `Limits` also bounds pending item
count/bytes, catalogue size, and decompressed file size so a malformed carousel
cannot grow memory without limit.

## Pipe into FFmpeg

`tlvdemux pipe` remuxes the first matching HEVC video and AAC-LATM audio tracks
to a non-seekable fragmented MP4 stream on stdout. Diagnostics are written only
to stderr, so the output can be connected directly to FFmpeg:

```sh
./build/tlvdemux pipe recording.mmts |
  ffmpeg -f mp4 -i pipe:0 -c copy output.mp4

curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  ./build/tlvdemux pipe - |
  ffmpeg -f mp4 -i pipe:0 -c:v copy -c:a aac output.mkv
```

Use `--service ID`, `--video-packet-id ID`, or `--audio-packet-id ID` when the
automatic first-track selection is not the desired programme. Both video and
audio codec configuration must arrive before output begins. `-f mp4` is
recommended because a pipe has no filename extension and the broadcast may
take time to deliver its initialization data.

For video-only consumers such as thumbnail extraction, `--video-only` emits a
single-track fragmented MP4 without waiting for or remuxing audio:

```sh
./build/tlvdemux pipe --video-only recording.mmts |
  ffmpeg -f mp4 -skip_frame nointra -i pipe:0 -frames:v 10 -f null -
```

When a finite consumer closes the pipe after receiving all requested frames,
`tlvdemux pipe` treats the closed stdout as normal consumer cancellation.
`--audio-packet-id` cannot be combined with `--video-only`.

## Inspect a stream

```sh
./build/tlvdemux inspect --list test.tlv
./build/tlvdemux inspect --trace-au test.tlv
./build/tlvdemux inspect --video video.hevc --audio audio.loas \
  --subtitle subtitle.ttml test.tlv
./build/tlvdemux inspect --audio secondary.loas \
  --audio-packet-id 0xf311 test.tlv
./build/tlvdemux analyze test.tlv
```

For TTML tracks, `inspect --list` reports the B60 subtitle signalling fields,
including `compression=0`, `compression=1` (schema-informed EXI), or
`compression=2` (schema-less EXI). With `--trace-au`, each subtitle access
unit also reports `subtitle-compression`, a payload classification
(`xml`, `exi`, or `binary`), and its first bytes, so a real EXI sample can
be identified before handing it to a renderer.

`tlvdemux analyze` scans the complete recording and inventories reconstructed
ARIB-HTML5 resources. For each virtual file it reports its path, MIME type,
decoded size and CRC32, carousel occurrence count, exact duplicate count, and
duplicate payload bytes. Duplicate classification compares the complete wire
payload; unknown, discontinuous, or changed units are reported but never
counted as removable.

Use Mirakurun's raw 4K path with `decode=0` when capturing validation input:

```sh
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' > test.tlv
```

For a live source-colour baseline, `scripts/compare_qvc_color.py` pulls QVC
CS161 (MPEG-TS service `700161`) and BS4K 221 (MMT/TLV service `1100221`) at
the same time, aligns their picture content, and records ten minutes of
linear-light statistics by default:

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux
```

Raw broadcast bytes and decoded frames are not saved. The report, complete
process logs and small aligned PPM previews are written below
`color-comparisons/`. The CS source is decoded as BT.709 SDR and the BS4K
source as BT.2020 HLG, then both are converted to linear BT.709 for analysis.
This diagnostic deliberately does not apply tlvdemux's SDR-in-HLG rewrite or
HLG-to-SDR LUT; those are candidate implementations, not the source baseline.
QVC CS161 is a bitrate-limited MPEG-2 service and is naturally softer than the
BS4K HEVC service. Use it as the simulcast SDR luma reference, not as a target
for BS4K spatial detail or local colour richness.

To measure the current project SDR result against that reference, enable the
explicit candidate path. This makes `tlvdemux pipe` rewrite strict HLG
`9/18/9` signalling to `9/1/9`, exports the exact C++ 8-bit 3D LUT, and applies
it with trilinear interpolation before the same analysis:

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux \
  --bs-mode current-sdr
```

To measure the same `1/13/9` carrier and prototype LUT as the browser demo,
select `prototype-sdr`.

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux \
  --duration 15 --fps 4 --max-offset 5 --snapshot-interval 5 \
  --bs-mode prototype-sdr
```

The corresponding low-level tools are also available directly:

```sh
tlvdemux hlg-sdr-lut > current-hlg-sdr.cube
tlvdemux hlg-sdr-lut --prototype > prototype-hlg-sdr.cube
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  tlvdemux pipe --video-only --sdr-in-hlg - |
  ffmpeg -f mp4 -i pipe:0 -f null -
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  tlvdemux pipe --video-only --hlg-sdr-prototype - |
  ffmpeg -f mp4 -i pipe:0 -f null -
```

`--sdr-in-hlg` is explicit and fixed for the selected video track. It does not
copy the browser demo's display-dependent `auto` policy into the CLI.

When more than one track of a kind is present, the diagnostic dumper writes the
first discovered supported track of that kind. `--trace-au` still reports every
emitted track.

The library assumes any required B61 descrambling has already happened before
the bytes reach `Demuxer::push()`. In the validation setup, Mirakurun
`decode=0` preserves the MMT/TLV stream while the tuner/frontend path supplies
already-usable media payloads. B61 message-authentication metadata is parsed so
an appended authentication code is not exposed as part of the media payload;
cryptographic verification itself remains the caller's responsibility.

## WebAssembly

Install the prebuilt single-file WebAssembly package from npm:

```sh
npm install tlvdemux
```

The package works with CommonJS directly and with the usual default-import
interop in ESM-aware bundlers:

```js
import createTlvDemuxModule from "tlvdemux";

const module = await createTlvDemuxModule();
const demuxer = new module.TlvDemuxer({
  onTrack: track => console.log(track),
  onAccessUnitView: unit => consumeSynchronously(unit),
  onError: error => console.warn(error),
});
```

For MSE players, `mseMaxAudioChannels` can reject layouts above the browser's
chosen limit without rewriting the AAC configuration. For example, a value of
`6` keeps mono through 5.1 tracks and suppresses a 22.2-channel AAC init
segment. Use `track.audio.channels` in `onTrack` to select a compatible
alternative track; omitted or zero leaves the remuxer unlimited.

#### Excluding BS8K 22.2-channel audio

Some BS8K programmes carry 22.2-channel (24-channel) AAC audio, represented by
`channel_configuration=13`. Chromium-based browsers do not accept this layout
through MSE, which may cause an audio `appendBuffer()` call to raise a
MediaError. For browser playback, setting the limit to six channels as shown
below allows mono through 5.1 while preventing a 22.2-channel MSE init segment
from being emitted.

```js
let selectedAudio = false;
const demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    const channels = track.audio?.channels ?? 0;
    if (!selectedAudio && track.kind === "audio" &&
        (channels === 0 || channels <= 6)) {
      selectedAudio = true;
      demuxer.selectTrack("audio", track.trackId);
    }
  },
  onMseInit: init => appendInitSegment(init),
  onMseSegment: segment => appendMediaSegment(segment),
});
```

This setting does not downmix 22.2-channel audio to 5.1. It is a safeguard that
keeps unsupported audio out of MSE. When multiple audio tracks are available,
use `track.audio.channels` to choose a 5.1 or stereo alternative. If the option
is omitted or set to `0`, no channel-count limit is applied.

TypeScript declarations for the module, callbacks, events, duration probe and
recording index are included. The npm package contains the generated wrapper
with its WebAssembly binary embedded, so consumers do not need Emscripten and
do not make a separate `.wasm` request.

### HLG to SDR renderer

`TlvDemuxer.hlgSdrColorLut()` returns a packed RGB 3D LUT generated by the C++
colour implementation. Import `HlgSdrRenderer` from
`tlvdemux/hlg-sdr-renderer` and pass that LUT to `setColorLut()`. The WebGPU and
WebGL backends then perform the same trilinear lookup; tone curves and colour
transforms do not live in separate JavaScript shaders. The older
`hlgSdrToneMappingLut()` 1D API remains temporarily available for compatibility
but should not be used by new integrations. `setMseToneMappingMode('on_compare')`
uses the same MSE signalling as `force`; pair it with
`HlgSdrRenderer.setComparisonEnabled(true)` to leave the left half without the
LUT and apply the LUT to the right half.

### iOS and iPadOS Safari

The WASM demuxer itself runs on current iOS Safari, including the `BigInt`
values used by the public API. Player integrations must not assume that the
standard `MediaSource` constructor exists, however: iOS exposes the compatible
`ManagedMediaSource` API instead. Select the constructor once and use it for
both capability checks and construction:

```js
const BrowserMediaSource = globalThis.ManagedMediaSource || globalThis.MediaSource;
if (!BrowserMediaSource?.isTypeSupported(mime)) throw new Error(`Unsupported: ${mime}`);
const mediaSource = new BrowserMediaSource();
```

Register the `sourceopen` listener before assigning the object URL to the video
element, then attach it and begin playback. `demo/demo.js` implements this
path. `demo/ios-compat.html` is a small feature and end-to-end diagnostic page;
it reports WASM, HEVC/AAC, MSE/MMS and SourceBuffer results separately.

Do not use the iOS Simulator as the final ManagedMediaSource playback verdict.
WebKit bug 266764 documents that the simulator can expose the API but never
open the source. Confirm the SourceBuffer stage on physical iPhone/iPad
hardware. See also WebKit's ManagedMediaSource integration example:

- https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/
- https://bugs.webkit.org/show_bug.cgi?id=266764

### Build the npm package

Build the browser/worker wrapper with Emscripten:

```sh
nix-shell
emcmake cmake -S . -B build-wasm -G Ninja \
  -DBUILD_SHARED_LIBS=OFF -DTLVDEMUX_BUILD_TOOLS=OFF
cmake --build build-wasm --target tlvdemux-wasm
```

From `nix-shell`, `npm run build` performs the same release build and copies the
result to `dist/tlvdemux.js`. `npm pack --dry-run` runs the release build and
WASM smoke test before showing the exact files that would be published.

The result is a single self-contained `build-wasm/tlvdemux.js`; the WebAssembly
binary is embedded and no separate `.wasm` request is made. Load it as a normal
script and create a demuxer asynchronously:

```js
const module = await createTlvDemuxModule();
const demuxer = new module.TlvDemuxer({
  onTrack: track => console.log(track),
  onEventInfo: event => console.log(event.title, event.startTimeUnixMilliseconds),
  onStreamEvent: event => console.log(event.eventMessageTag, event.messageId),
  onAccessUnitView: unit => consumeSynchronously(unit),
  onApplicationState: application => console.log(application.state),
  onApplicationResourceView: resource => console.log(resource.path),
  onError: error => console.warn(error),
});

demuxer.push(chunk); // Uint8Array; copied into WASM memory
demuxer.flush();
demuxer.delete();
```

For loaders that already manage buffers, `_malloc`, `_free`, `HEAPU8`, and
`pushFromHeap(address, size)` provide a reusable heap-buffer path. JavaScript
receives 64-bit offsets, timestamps, and track IDs as `BigInt` values.
MH-EIT current/following and schedule entries are reported through
`onEventInfo`; `tableId === 0x8b` with `sectionNumber` 0/1 identifies the
present/following event for the service.
ARIB STD-B60 EMT messages are reported through `onStreamEvent`. The event
contains the MPT-signalled EMT tag, group/id/version, private bytes, and the raw
time-mode fields so the receiver can ignite timed messages against its playback
clock instead of the demux/read-ahead clock. `rawMessageId` preserves B60's
16-bit descriptor field; its high octet is exposed as `messageId` and its low
octet as `messageVersion` to the B62 application.
`onAccessUnitView` avoids copying media output, but its `data` view is valid only
for the duration of the callback and must be consumed synchronously. Use
`onAccessUnit` instead when the callback needs an owned `Uint8Array` copy.
`onApplicationResourceView` has the same callback-only lifetime; use
`onApplicationResource` for an owned copy.

`TlvDemuxer` also owns an `ApplicationResourceStore`. `applicationResources()`
lists its files, `applicationResource(contextId, path)` returns an owned file,
`applications()` reports current application states, and
`applicationEntry(contextId)` resolves the ready entry document. This keeps
path validation, version replacement, and entry resolution in C++/WASM rather
than duplicating those rules in each browser loader.

Run the application-resource WASM integration test against a captured stream
with:

```sh
node tests/wasm_application_resources.mjs build-wasm/tlvdemux.js test.tlv
```

`DurationProbe` drives fast head/tail reads without owning a file or HTTP
client. Start it with the known file size, fulfill each object returned by
`nextRange()`, and pass the exact bytes to `pushRange()`. A successful
`duration()` has `status: "complete"`; failure remains explicit through
`state()` and `failure()` and never falls back to downloading the whole file.
The native `tlvdemux probe INPUT` command exercises the same protocol.

For precise recorded seek, call `startIndex(false)` before feeding the full
stream and `finalizeIndex()` at its real EOF. `seekPointsFor(targetUs)` returns
the surrounding RAP checkpoints. Reposition to `first.signallingOffset`, feed
from there, decode from the emitted RAP, and present the first frame at or after
the requested time.

The recording index has a lifecycle separate from the demux session. A VOD
scan starts in `building`; `finalizeIndex()` makes its duration and seek points
complete. Use `startIndex(true)` for a growing recording and finalize only when
the source has permanently stopped growing. `reposition()` preserves the
current index, whereas `reset()` or `selectService()` restarts an active index
from empty. `flush()` alone never finalizes it.

### Browser demo

Build the sibling `libaribhtml5` receiver SDK and `build-wasm/tlvdemux.js`, then
serve the repository root and open `/demo/`:

```sh
(cd ../libaribhtml5 && pnpm build:sdk)
node demo/server.mjs
```

The bundled development server supports the `206` and `Content-Range`
responses required by duration probing and recorded seek. Python's basic
`python3 -m http.server` is not suitable for this demo because it does not
provide the required Range behavior.

The demo accepts either a local MMTS file or an HTTP URL, probes its duration,
then plays the selected HEVC and AAC tracks through Media Source Extensions.
Every fresh playback entry starts at timestamp zero. The demo intentionally has
no preset seek-and-pause comparison buttons; later positioning is only an
explicit user seek.
Application resources collected by WASM are exposed to a sandboxed data-
broadcast iframe through the same-origin Service Worker VFS shipped by
`libaribhtml5`. The receiver API, video-plane handling, document preparation,
built-in ROM sounds, and remote-control behavior also come from
`libaribhtml5`; external application URLs remain blocked.
Local files use `Blob.slice()`; remote files require validated `206` and
`Content-Range` responses. Live mode skips duration probing and seeking, uses a
normal streaming `GET`, and exposes the Media Source as an unbounded timeline.
HTTP URLs that do not return a valid Range response automatically fall back to
Live mode.
The demo contains a deliberately small fMP4/MSE layer and does not depend on
mmts.js at runtime. Browser HEVC MSE support is still required.

Demuxing and fMP4 remuxing run in the public `worker/demux-worker-runtime.js`. The main
thread sends input chunks as transferable buffers and receives only MSE init
segments, media segments, subtitle payloads, application files, and small
control events. `worker-tlvdemux.mjs` owns the RPC facade and
`worker/demux-worker-runtime.js` is a self-contained classic Worker entry that
can also be bundled by a consumer's Worker loader. Keeping UI outside this
public pair lets consumers change presentation without copying the RPC or
worker-side demux lifecycle.

Run the repeatable WASM throughput benchmark with:

```sh
npm run benchmark:wasm -- build-wasm/tlvdemux.js test.tlv 268435456
```

It reports demux-only and demux-plus-MSE throughput, callback/segment counts,
output bytes, and maximum observed WASM heap size. See
[`docs/performance.md`](docs/performance.md) for the hot-path ownership map,
measurement guidance, and regression checklist.

## Current scope

Version 0.1 supports the ARIB broadcast subset exercised by the validation
streams: all four HCfB compressed-IP modes (`0x20`, `0x21`, `0x60`, `0x61`),
MMTP signalling and fragmented media, HEVC Annex B, AAC-LATM/LOAS, and ARIB
STD-B62 TTML. The recording helpers provide bounded duration probing, sparse RAP
indexing, and recording-relative repositioning. CAS/descrambling, decoder and
TTML rendering, persistent index serialization, and general-purpose ISO MMT are
outside the library's current scope.
