# Video colour signalling for browser playback

## Goal

Browser playback must receive the colour characteristics of the coded HEVC
samples.  This is CICP signalling, not an ICC display profile.  For fragmented
MP4/MSE the init segment must carry an `nclx` `colr` box derived from the active
HEVC SPS VUI.

`mmts.js` is outside this work.  The implementation boundary is the maintained
`libaribtlv` demuxer plus the `tlvdemux` MSE remuxer.

## Standards evidence

ARIB STD-B32 Version 3.11, Part 1, section 5.5.3.3.2.2 mandates HEVC VUI video
signal information for advanced BS digital broadcasting.  Its permitted CICP
values include:

| Programme type | Colour primaries | Transfer characteristics | Matrix coefficients | Full range |
| --- | ---: | ---: | ---: | --- |
| HDTV SDR, BT.709 | 1 | 1 | 1 | false |
| HDTV wide-gamut SDR | 9 | 11 | 9 | false |
| UHDTV SDR | 9 | 14 | 9 | false |
| HDR, PQ | 9 | 16 | 9 | false |
| HDR, HLG | 9 | 18 | 9 | false |

ARIB STD-B60 Version 1.14-E1 separately describes programme-level MMT-SI:

- `0x800A`, MH-HEVC video descriptor: `HDR_WCG_idc` identifies SDR, WCG,
  HDR+WCG, or unspecified.
- `0x8010`, video component descriptor: `video_transfer_characteristics`
  maps values 1 through 5 to VUI transfer values 1, 11, 14, 16, and 18.

The B60 descriptors classify the announced component, but they do not contain
the complete CICP tuple needed by an MP4 `nclx` box.

## Analysis implementation chain and required packet corpus

The analysed device/package implementations split this path across the decoder,
video-processing engine, display/output capability, and a policy/configuration
layer. The policy tables are platform-specific; they are not a
standards-defined PQ transfer curve. The portable receive path should
therefore preserve these boundaries:

```text
MMTP-SI / B60 descriptors -> HEVC VUI + SEI -> decoded HDR/WCG signal
        -> output capability/policy (HDMI or browser display)
        -> tone/gamut mapping -> rendered surface
```

The minimum capture/fixture set is:

| Packet or sample | Required variants | What it proves |
| --- | --- | --- |
| MPT video asset descriptors `0x800A` + `0x8010` | B60 transfer values 1, 2, 3, 4, 5; HDR/WCG idc present, absent, and each defined value | `libaribtlv` programme-level metadata and mismatch handling |
| HEVC VPS/SPS/PPS | CICP `1/1/1`, `9/11/9`, `9/14/9`, `9/16/9`, `9/18/9`; limited/full range; VUI absent | `tlvdemux` coded-signal authority and exact `nclx` output |
| HEVC HDR SEI | mastering-display colour volume, content-light level, and no-SEI cases | whether metadata is preserved, ignored, or made available before tone mapping |
| MMTP MPU/MFU sequence | RAP followed by SPS change, timestamp descriptor, and one discontinuity | configuration boundary and colour-state reconfiguration |
| Output capability sample | HDMI EDID / HDR InfoFrame or browser display capability | target peak luminance, EOTF, gamut, and deep colour; required to choose a tone mapper |

The current native fixture now includes both the existing HLG descriptor packet
and a PQ descriptor packet (`0x8010` value 4). It intentionally does not turn
that B60 hint into PQ pixels: the next missing evidence is an HEVC SPS/SEI
sample paired with a known output target. Platform-specific tables may be
retained as diagnostic inputs, but must not become a default `libaribtlv`
algorithm.

When present, `tlvdemux` now carries HEVC mastering-display SEI 137 and
content-light SEI 144 into the video sample entry as the standard `mdcv` and
`clli` boxes, and exposes the same values on the video-properties callback.
Missing SEIs remain missing; the remuxer does not synthesize HDR metadata from
the B60 transfer value alone.

At the MSE boundary, B60 `HDR_WCG_idc` and transfer values are exposed as
programme-level source signalling beside the coded SPS colour. If a defined
B60 transfer maps to a different CICP transfer than the active SPS, the
properties callback reports a mismatch while the original SPS colour remains
authoritative.

The WASM policy boundary accepts the display's HLG support through
`setMseHlgOutputSupported`. That capability is retained for the output policy,
but `auto` does not rewrite an unknown or confirmed HDR source merely because
HLG output is unavailable: the current path has no pixel-domain HDR-to-SDR
conversion. Explicit `force`, `prototype`, and `off` modes retain their
existing meaning. PQ capability and target luminance remain inputs for a later
PQ-to-SDR policy and are not guessed here.

### Actual packet observations

The current capture set provides two useful end-to-end references:

| Capture | B60 video transfer | Extracted HEVC/MSE colour | Prefix-SEI payload types observed |
| --- | ---: | --- | --- |
| `bs4k-sample/101.pending.mmts` | 3 | `nclx 9/14/9`, limited range | 0, 1, 6 |
| `bs4k-sample/102.pending.mmts` | 5 | `nclx 9/18/9`, limited range | 0, 1, 2, 6 |

The `nclx` values were obtained from the actual video output produced by
`tlvdemux pipe --video-only`, while the SEI list was obtained from the actual
HEVC access units produced by `tlvdemux inspect --video`. No mastering-display
or content-light payload (SEI types 137 or 144) was present in these two
samples. They are sufficient to validate B60-to-VUI agreement and SEI
preservation, but a separate real PQ sample with those payloads is still
needed before implementing a target-dependent PQ tone mapper.

Real BS4K captures show that `HDR_WCG_idc` may be absent even when the HEVC
SPS is HLG. The maintained `libaribtlv` API therefore exposes the positive
MH-EIT HDR programme icon as `VideoPresentationHint::Hdr`; absence is
`Unknown`, not a negative HDR assertion. The browser demo uses the current
present-event hint as a positive signal: a positive HDR hint preserves native
HLG, while an unknown programme leaves the source untouched in `auto` mode. An
explicit B60 video transfer value of `3` (UHD SDR) may enable the SDR-in-HLG
rewrite when the coded SPS nevertheless declares HLG. Absence of both signals
is not a negative HDR assertion.

This is a signalling reinterpretation, not a pixel tone-mapping algorithm.
The practical case is SDR programme material carried with an HLG transfer
declaration: removing only the HLG transfer declaration (`9/18/9` -> `9/1/9`)
lets the browser avoid its HLG HDR path while preserving the BT.2020-NCL YUV
decode and gamut information carried by the stream. The matrix is not an HDR
flag: changing it would change the decoded colours. A true tone
mapper would need to process decoded pixels through HLG inverse OETF, display
mapping, and gamut conversion; MSE metadata cannot perform that operation.

The demo exposes four policies:

| Policy | Behaviour |
| --- | --- |
| `auto` | Use structured programme hints and explicit B60 SDR metadata; otherwise preserve HLG. |
| `force` | Remove the HLG transfer signalling from each HLG SPS and advertise SDR transfer `9/1/9`. This is user-controlled and is not a definitive SDR classification. |
| `on_compare` | Apply the same signalling policy as `force`; the renderer leaves the left half without the 3D LUT and applies the C++-generated LUT to the right half. |
| `off` | Preserve source signalling and let the browser handle HLG/HDR. |

### Rejected metadata-only browser experiment

On 2026-08-26, real browser playback of
`20260815-141-020000_34968268-7eab-4ee5-ab93-d2097c3d839f.mmts` tested the
strict `9/18/9` to `9/1/9` SPS/`nclx` rewrite with both GPU LUT canvases
disabled. At 03:19 the visible result had severe highlight clipping,
overexposure, and red/orange oversaturation. This proves that metadata-only
reinterpretation is not a usable HLG-to-SDR path for this real programme.

The rejected standalone mode must not be exposed in the browser demo or
selected by the automatic policy. The split `on_compare` diagnostic may retain
the uncorrected half only to make the failure visible beside the LUT result.
Real HLG must either retain native HLG signalling for a capable browser/display
path or undergo pixel-domain tone and gamut mapping.

## Ownership and precedence

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| `libaribtlv` | Parse B60 `0x800A` and `0x8010`; expose their colour-relevant fields on `TrackInfo.video` | Parse codec SPS bytes or invent missing CICP values |
| `tlvdemux` HEVC parser | Parse the active SPS VUI, including range, primaries, transfer, and matrix; rewrite an HLG SPS only when the selected policy requests it | Infer colour from resolution, bit depth, or absent metadata |
| `tlvdemux` MP4 builder | Serialize the SPS-derived tuple as `colr`/`nclx` beside `hvcC` | Emit a partially guessed `nclx` tuple |
| Browser | Interpret the MP4 sample entry and render to the output display | Recover omitted source signalling reliably |

The active SPS VUI is authoritative because it describes the coded samples.
B60 metadata is an early programme-level hint and a cross-check.  If the two
disagree, remuxing follows the SPS and the mismatch should be observable in
diagnostics; it must not silently rewrite the bitstream's declared colour.

If the SPS omits `video_signal_type` or `colour_description`, the remuxer keeps
the raw SPS in `hvcC` but does not manufacture `colr`.  An incomplete tuple is
not filled from resolution or an HDR label.

## Implementation order

1. In `libaribtlv`, add optional video signalling to `TrackInfo`, parse
   `HDR_WCG_idc` from `0x800A` and `video_transfer_characteristics` from
   `0x8010`, and test descriptor-to-track propagation.
2. In `tlvdemux`, finish the HEVC SPS syntax walk through VUI and expose a
   complete optional CICP tuple from `hevc_configuration()`.
3. Add an MP4 `colr` box with colour type `nclx`, three unsigned 16-bit CICP
   indices, and the one-bit full-range flag. For an explicitly selected
   SDR-in-HLG track, update the matching SPS in `hvcC` from HLG `9/18/9` to
   SDR-transfer `9/1/9` as well, so browser decoder state and container metadata
   agree without changing the coded YUV matrix.
4. Validate an ARIB HLG sample as `9/18/9`, limited range, in both the parsed
   configuration and generated init segment.

## Configuration changes

Parameter sets are configuration state.  Before the first video sample, the
remuxer collects VPS/SPS/PPS and emits one matching init segment.  If a later
random-access unit activates a different SPS or changes its CICP tuple, old
samples must be flushed before a new configuration boundary; samples described
by different tuples must never be placed under one sample entry.

An SDR-in-HLG policy change is applied at the next RAP. The remuxer emits a
new init segment and a video splice at that boundary; it does not reinterpret
already-appended samples under a different colour declaration.

The WASM layer also emits `onMseVideoProperties` at the first active parameter
set and whenever the source or effective presentation state changes at a RAP.
The event is timeline-scoped: it carries the video track, the input PTS in
microseconds, the HEVC VUI colour tuple before and after remuxing, and the
`sdrInHlg` decision. A single recording may therefore emit HLG, SDR-in-HLG,
and HLG again; consumers must replace their current state rather than cache a
file-wide HDR boolean. A changed SPS without a corresponding metadata change
still updates this state from the coded stream. If neither SPS signalling nor
the structured programme metadata changes, the content cannot be classified
reliably from the byte stream alone. That limitation is why `force` is exposed
as a display policy rather than presented as automatic SDR detection.

## Verification boundary

Native and WebAssembly tests can prove SPS parsing and exact MP4 bytes.  They do
not prove that a particular browser/display pipeline renders HDR correctly.
Browser acceptance additionally requires inspecting the appended init segment
and the browser's decoded colour-space state on an HDR-capable path.
