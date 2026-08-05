#pragma once

#include <aribtlv/types.hpp>

#include <tlvdemux/mse_remuxer.hpp>

#include <cstdint>
#include <memory>
#include <optional>

#include <emscripten/val.h>

class WasmMseRemuxer {
public:
    explicit WasmMseRemuxer(emscripten::val callbacks,
                            std::uint32_t max_audio_channels = 0);
    ~WasmMseRemuxer();
    WasmMseRemuxer(const WasmMseRemuxer&) = delete;
    WasmMseRemuxer& operator=(const WasmMseRemuxer&) = delete;

    void selectTrack(aribtlv::TrackKind kind, std::optional<std::uint64_t> track_id);
    void setOutputEnabled(bool enabled) noexcept;
    void push(const aribtlv::AccessUnit& unit);
    void flush();
    void reset();
    void reposition();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
