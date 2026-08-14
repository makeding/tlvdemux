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

## Ownership and precedence

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| `libaribtlv` | Parse B60 `0x800A` and `0x8010`; expose their colour-relevant fields on `TrackInfo.video` | Parse codec SPS bytes or invent missing CICP values |
| `tlvdemux` HEVC parser | Parse the active SPS VUI, including range, primaries, transfer, and matrix | Infer colour from resolution, bit depth, or B60 classification |
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
   indices, and the one-bit full-range flag.  Keep `hvcC` unchanged.
4. Validate an ARIB HLG sample as `9/18/9`, limited range, in both the parsed
   configuration and generated init segment.

## Configuration changes

Parameter sets are configuration state.  Before the first video sample, the
remuxer collects VPS/SPS/PPS and emits one matching init segment.  If a later
random-access unit activates a different SPS or changes its CICP tuple, old
samples must be flushed before a new configuration boundary; samples described
by different tuples must never be placed under one sample entry.

The first patch covers initial configuration signalling.  Reconfiguration is a
separate lifecycle change and requires an explicit init-segment replacement
path in the MSE consumer rather than silently appending another init segment.

## Verification boundary

Native and WebAssembly tests can prove SPS parsing and exact MP4 bytes.  They do
not prove that a particular browser/display pipeline renders HDR correctly.
Browser acceptance additionally requires inspecting the appended init segment
and the browser's decoded colour-space state on an HDR-capable path.
