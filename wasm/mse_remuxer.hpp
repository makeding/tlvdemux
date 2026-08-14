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
    std::optional<std::int64_t> switchAudioTrack(
        std::uint64_t track_id, std::int64_t earliest_presentation_time_us);
    bool switchLayer(std::uint64_t video_track_id, std::uint64_t audio_track_id,
                     std::int64_t earliest_presentation_time_us);
    void setOutputEnabled(bool enabled);
    void push(const aribtlv::AccessUnit& unit);
    void flush();
    void reset();
    void reposition();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
