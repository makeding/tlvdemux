#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace tlvdemux::tools::vt_probe {

struct Options {
    std::string path;
    std::size_t maximum_access_units = 300;
    std::uint64_t offset = 0;
    double playback_rate = 0.0;
    std::size_t inflight_frames = 1;
    bool prepend_parameter_sets_on_irap = false;
    bool skip_leading_rasl = false;
    bool mse_pipeline = false;
    bool timeline_only = false;
    bool require_hardware = true;
    bool expect_rainfall_init = false;
    std::optional<std::uint32_t> service_context_id;
    std::optional<std::uint16_t> video_packet_id;
    std::optional<std::uint16_t> audio_packet_id;
    std::optional<std::uint16_t> fallback_video_packet_id;
    std::optional<std::uint16_t> fallback_audio_packet_id;
    std::size_t random_seeks = 0;
    std::uint64_t seed = 0x544c564d5345ULL;
    std::optional<double> target_seconds;
};

bool run_probe(const Options&, std::uint64_t offset, std::size_t case_index);

} // namespace tlvdemux::tools::vt_probe
