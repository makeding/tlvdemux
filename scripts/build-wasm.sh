#!/usr/bin/env sh

set -eu

EM_CACHE="${EM_CACHE:-$PWD/build-wasm/emscripten-cache}"
export EM_CACHE

# Initialize Emscripten's generated sysroot before Ninja starts parallel jobs.
embuilder build sysroot zlib

emcmake cmake -S . -B build-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF \
  -DTLVDEMUX_BUILD_TOOLS=OFF \
  -DTLVDEMUX_USE_SYSTEM_LIBARIBTLV=OFF \
  -DTLVDEMUX_LIBARIBTLV_SOURCE_DIR=
cmake --build build-wasm --target tlvdemux-wasm
