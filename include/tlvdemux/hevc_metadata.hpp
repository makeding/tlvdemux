#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <vector>

namespace tlvdemux {

struct HevcColorInformation {
    std::uint16_t primaries = 0;
    std::uint16_t transfer = 0;
    std::uint16_t matrix = 0;
    bool full_range = false;
    bool operator==(const HevcColorInformation&) const = default;
};

struct HevcHdrStaticMetadata {
    std::array<std::uint16_t, 3> display_primaries_x{};
    std::array<std::uint16_t, 3> display_primaries_y{};
    std::uint16_t white_point_x = 0;
    std::uint16_t white_point_y = 0;
    std::uint32_t max_display_mastering_luminance = 0;
    std::uint32_t min_display_mastering_luminance = 0;
    std::uint16_t max_content_light_level = 0;
    std::uint16_t max_pic_average_light_level = 0;
    bool has_mastering_display = false;
    bool has_content_light = false;
    bool operator==(const HevcHdrStaticMetadata&) const = default;
};

struct HevcVideoMetadata {
    std::optional<HevcColorInformation> color;
    std::optional<HevcHdrStaticMetadata> hdr_static_metadata;
};

// Reads VUI colour information and static HDR SEI messages from an Annex-B
// HEVC access unit. Returns nullopt when neither kind of metadata is present.
std::optional<HevcVideoMetadata> parse_hevc_video_metadata(
    const std::vector<std::uint8_t>& annex_b_access_unit);

} // namespace tlvdemux
