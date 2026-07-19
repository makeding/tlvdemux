#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux {

enum class Codec { Hevc, AacLatm, Ttml };
enum class TrackKind { Video, Audio, Subtitle };

enum class AudioChannelLayout {
    Unknown,
    Mono,
    DualMono,
    Stereo,
    Channels2_1,
    Channels3_0,
    Channels2_2,
    Channels4_0,
    Channels5_0,
    Channels5_1,
    Channels3_3_1,
    Channels6_1,
    Channels7_1,
    Channels10_2,
    Channels22_2,
};

struct AudioInfo {
    std::uint8_t stream_content = 0;
    std::uint8_t component_type = 0;
    std::uint16_t component_tag = 0;
    AudioChannelLayout channel_layout = AudioChannelLayout::Unknown;
    std::uint8_t stream_type = 0;
    std::uint8_t simulcast_group_tag = 0;
    bool es_multi_lingual = false;
    bool main_component = false;
    std::uint8_t quality_indicator = 0;
    std::uint8_t sampling_rate_code = 0;
    std::uint32_t sample_rate = 0;
    std::string secondary_language;
};

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
    std::uint16_t component_tag = 0;
    std::uint32_t timescale = 1;
    std::optional<AudioInfo> audio;
};

struct SubtitleResource {
    std::uint8_t subsample_number = 0;
    std::uint8_t data_type = 0;
    std::vector<std::uint8_t> data;
};

struct AccessUnit {
    std::uint64_t track_id = 0;
    Codec codec = Codec::Hevc;
    std::vector<std::uint8_t> data;
    std::vector<SubtitleResource> subtitle_resources;
    Timestamp pts;
    Timestamp dts;
    std::optional<Timestamp> source_ntp;
    std::uint64_t restart_offset = 0;
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
