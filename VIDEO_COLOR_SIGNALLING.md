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
declaration: removing the HLG/HDR declaration (`9/18/9`) and advertising
ordinary SDR (`1/1/1`) lets the browser avoid its HLG HDR path and apply the
normal SDR display curve. The BT.709 matrix (`1`) keeps the SDR primaries,
transfer, and YUV interpretation self-consistent. A true tone
mapper would need to process decoded pixels through HLG inverse OETF, display
mapping, and gamut conversion; MSE metadata cannot perform that operation.

The demo exposes three policies:

| Policy | Behaviour |
| --- | --- |
| `auto` | Use structured programme hints and explicit B60 SDR metadata; otherwise preserve HLG. |
| `force` | Remove HLG/HDR signalling from each HLG SPS and advertise SDR `1/1/1`. This is user-controlled and is not a definitive SDR classification. |
| `off` | Preserve source signalling and let the browser handle HLG/HDR. |

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
   SDR `1/1/1` as well, so browser decoder state and container metadata agree.
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
