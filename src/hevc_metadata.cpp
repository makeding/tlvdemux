#include <tlvdemux/hevc_metadata.hpp>

#include "mse/hevc_parser.hpp"

namespace tlvdemux {
namespace {

HevcColorInformation public_color(const detail::mse::ColorInformation& color) {
    return {color.primaries, color.transfer, color.matrix, color.full_range};
}

HevcHdrStaticMetadata public_hdr(
    const detail::mse::HdrStaticMetadata& metadata) {
    return {metadata.display_primaries_x,
            metadata.display_primaries_y,
            metadata.white_point_x,
            metadata.white_point_y,
            metadata.max_display_mastering_luminance,
            metadata.min_display_mastering_luminance,
            metadata.max_content_light_level,
            metadata.max_pic_average_light_level,
            metadata.has_mastering_display,
            metadata.has_content_light};
}

} // namespace

std::optional<HevcVideoMetadata> parse_hevc_video_metadata(
    const std::vector<std::uint8_t>& annex_b_access_unit) {
    HevcVideoMetadata output;
    if (const auto color = detail::mse::hevc_color_information(annex_b_access_unit)) {
        output.color = public_color(*color);
    }
    if (const auto hdr = detail::mse::hdr_static_metadata(annex_b_access_unit)) {
        output.hdr_static_metadata = public_hdr(*hdr);
    }
    if (!output.color && !output.hdr_static_metadata) return std::nullopt;
    return output;
}

} // namespace tlvdemux
