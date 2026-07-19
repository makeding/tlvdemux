# tlvdemux

`tlvdemux` is a C++17, standard-library-only incremental demultiplexer for
already-descrambled ARIB MMT/TLV streams. It is designed to emit player-ready
HEVC, AAC-LATM/LOAS and ARIB STD-B62 TTML access units without converting the
stream to MPEG-TS or exposing FFmpeg ABI types.

The implementation is in progress. The current milestone provides the stable
public callback API, bounded incremental TLV framing and resynchronization,
compressed-IP context isolation, MMTP fixed-header validation, signalling
fragment/aggregation validation, and the public diagnostic CLI. MPT track
discovery, timestamps and codec access-unit emission are the next milestone.

## Build and test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

No runtime dependency other than the C++ standard library is required.

## Inspect a stream

```sh
./build/tlvdemux-inspect --list test.tlv
./build/tlvdemux-inspect --trace-au test.tlv
```

Use Mirakurun's raw 4K path with `decode=0` when capturing validation input:

```sh
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' > test.tlv
```

The library assumes any required B61 descrambling has already happened before
the bytes reach `Demuxer::push()`.

