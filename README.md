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

### Recorded playback contract

Recorded/File playback has one SDK-owned controller:
`createMseRecordedPlaybackController()`. It owns sequential source reads, the
demux transaction, both MSE queues, the playback-intent generation, startup, and
explicit seek. No other Recorded path may reposition the source, write
`MediaElement.currentTime`, rebuild MediaSource, retry quota from a timer or
`waiting` event, or change the requested playback rate.

The selected AAC track is the canonical recorded timeline. Startup and seek first
locate an AAC window, identified by presentation time and input offset, and only
then resolve video for that exact audio window in this order:

1. a decodable preferred/main closed GOP;
2. a decodable rainfall/fallback closed GOP covering the same AAC window;
3. the last usable decodable IRAP picture before the window, repeated with
   monotonic video DTS/PTS while the original AAC continues unchanged.

A future frame is never copied backward. During ordinary sequential playback,
source damage seals the complete preferred-video prefix and selected AAC remains
the only continuity clock. A covering closed rainfall GOP may replace video
only; it never changes the selected AAC track. If no covering rainfall GOP is
available, or it cannot commit within one AAC window, the last decodable
pre-damage IRAP/CRA is repeated in normal-sized fragments through every emitted
AAC window, including AAC EOS. Video output must not stop merely because no
fallback layer or later stable RAP exists. Repeated damage discards only the
current preferred candidate GOP; frozen output continues. The first complete
preferred GOP is observed without backfill, and the following undamaged RAP is
the video-only splice boundary back to real pictures.

The native continuity states are `normal`, `damage-sealed`, `fallback-pending`,
`frozen`, `preferred-candidate`, and `restoring`. Diagnostics expose that state,
the damage start, selected-AAC frontier, frozen-through endpoint, candidate RAP,
fallback video track, and last emitted video endpoint. Quota pressure and a bare
`waiting` event are never recorded as the cause of video recovery and never
enter this state machine. A decoder-performance fallback is
sticky until an explicit seek or reload. It is triggered immediately by an
explicit decoder/MediaElement error, or after two consecutive five-second
quality windows each drop more than 20% of frames while at least one wall-clock
second of common A/V remains buffered.

The controller's linear transaction states are `idle`, `locating-audio`,
`resolving-video`, `committing`, `running`, `ended`, and `error`.
Video selection is orthogonal state: `preferred`, `rainfall`, or `frozen`.
Every AAC window is an atomic A/V commit: both queues must acknowledge
`updateend` before the next window is read. Recorded forward reserve is two
wall-clock seconds and refills below one wall-clock second; playback rate scales
only the media duration represented by those watermarks (for example 4/2 media
seconds at 2x). There is no 15- or 30-second startup gate.
If the browser reports its quota ceiling before the preferred reserve is
reached, the controller starts consumption as soon as the entry has at least
0.5 wall-clock seconds of common A/V; the controller, not the demo, owns this
quota-limited startup decision.

Quota pressure pauses source reading and retains the failed original window.
Only removal of complete history windows strictly before the last compositor-
presented boundary, while preserving the current decode GOP and three seconds of
video history, permits exactly one retry of that same window. Quota, ordinary
`waiting`, or demand never authorizes a seek or an unbounded retry.
`MSE_RECORDED_SUPPLY_STALLED` is not a valid Recorded outcome.

`start()` and `seek(targetSeconds)` use this same controller and the same hard
16 MiB transaction budget across probe, landing, and formal commit. Explicit
seek progresses through `seek-audio-anchor`, `seek-preferred`, `seek-rainfall`,
`seek-prior-frame`, `seek-commit`, and `seek-resume`. It locks the selected AAC
target window first, resolves preferred/rainfall/prior-frame video, and performs
one formal A/V commit. Preferred and rainfall failure therefore freezes the last
decodable picture before the target across the complete AAC landing window.
The requested `currentTime` remains unchanged during probing and is installed
only for that explicit seek after commit. A superseding seek cancels the older
source stream and transaction. Errors are limited to a missing AAC anchor,
absence of preferred/rainfall/earlier decodable video within the budget, source
failure, or atomic commit failure, and include a full state snapshot.

Blob and strict-Range HTTP recordings expose `stream(offset, {signal})`. Blob
streams sequentially; HTTP uses one `Range: bytes=<offset>-` response.
Recorded and Live use the same 512 KiB / 25 ms input coalescer.
`read(offset, length)` is reserved for duration probing and explicit seek;
after seek the old stream is aborted and a new sequential stream begins at the
real committed `nextOffset`. A Recorded byte reposition/landing boundary is not
source damage and cannot open continuity recovery.

No separate Recorded seek session, damage-recovery seek, audio-only rebuild, or
resilience controller is part of this contract. A bare `waiting` event only
reports that consumption reached unavailable data. It never changes
`currentTime`, starts a hidden seek, changes playback rate, reconstructs MSE,
or grants additional input.

## Library usage

Browser integrations create the Recorded controller instead of copying source,
seek, fallback, or quota policy into the application.

```js
import {createMseRecordedPlaybackController}
  from 'tlvdemux/mse-recorded-playback';

const recorded = createMseRecordedPlaybackController({
  source, demuxer, media, queues, selectedAudioTrack,
  preferredVideoTrack, rainfallVideoTrack,
});
await recorded.start();
await recorded.seek(targetSeconds);
```

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
