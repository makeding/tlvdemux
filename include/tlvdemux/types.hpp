#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux {

enum class Codec { Hevc, AacLatm, Ttml };
enum class TrackKind { Video, Audio, Subtitle };

struct Timestamp {
    std::int64_t value = 0;
    std::uint32_t timescale = 1;
};

struct ServiceInfo {
    std::uint32_t context_id = 0;
    std::vector<std::uint8_t> package_id;
};

struct TrackInfo {
    std::uint64_t track_id = 0;
    std::uint32_t context_id = 0;
    std::uint16_t packet_id = 0;
    std::vector<std::uint8_t> asset_id;
    TrackKind kind = TrackKind::Video;
    Codec codec = Codec::Hevc;
    std::string language;
    std::uint8_t component_tag = 0;
    std::uint32_t timescale = 1;
};

struct AccessUnit {
    std::uint64_t track_id = 0;
    Codec codec = Codec::Hevc;
    std::vector<std::uint8_t> data;
    Timestamp pts;
    Timestamp dts;
    std::optional<Timestamp> source_ntp;
    std::uint64_t input_offset = 0;
    bool random_access = false;
    bool discontinuity = false;
};

enum class ErrorCode {
    MalformedInput,
    UnsupportedFeature,
    Discontinuity,
    ResourceLimit,
};

struct Error {
    ErrorCode code = ErrorCode::MalformedInput;
    std::uint64_t input_offset = 0;
    bool recoverable = true;
    std::string message;
};

struct Limits {
    std::size_t max_tlv_payload = 65535;
    std::size_t max_resync_buffer = 1024 * 1024;
    std::size_t max_signalling_message = 1024 * 1024;
    std::size_t max_access_unit = 16 * 1024 * 1024;
    std::size_t max_ttml_sample = 4 * 1024 * 1024;
    std::size_t max_contexts = 64;
    std::size_t max_packet_states = 256;
};

} // namespace tlvdemux

