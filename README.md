# tlvdemux

`tlvdemux` is a C++17, standard-library-only incremental demultiplexer for
already-descrambled ARIB MMT/TLV streams. It is designed to emit player-ready
HEVC, AAC-LATM/LOAS and ARIB STD-B62 TTML access units without converting the
stream to MPEG-TS or exposing FFmpeg ABI types.

The current implementation provides the stable public callback API, bounded
incremental TLV resynchronization, compressed-IP context isolation, MMTP
fragment/aggregation handling, PA/M2/MPT track discovery, descriptor-driven
timelines, and HEVC/AAC-LATM/TTML access-unit output.

## Build and test

```sh
nix-shell -p cmake --run 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release'
nix-shell -p cmake --run 'cmake --build build -j8'
nix-shell -p cmake --run 'ctest --test-dir build --output-on-failure'
```

No runtime dependency other than the C++ standard library is required.

## Inspect a stream

```sh
./build/tlvdemux-inspect --list test.tlv
./build/tlvdemux-inspect --trace-au test.tlv
./build/tlvdemux-inspect --video video.hevc --audio audio.loas \
  --subtitle subtitle.ttml test.tlv
```

Use Mirakurun's raw 4K path with `decode=0` when capturing validation input:

```sh
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' > test.tlv
```

When more than one track of a kind is present, the diagnostic dumper writes the
first discovered supported track of that kind. `--trace-au` still reports every
emitted track.

The library assumes any required B61 descrambling has already happened before
the bytes reach `Demuxer::push()`. In the validation setup, Mirakurun
`decode=0` preserves the MMT/TLV stream while the tuner/frontend path supplies
already-usable media payloads.
