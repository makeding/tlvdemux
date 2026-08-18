#pragma once

#include <cstdint>
#include <span>

namespace tlvdemux {

enum class MseOutputColorSpace : std::uint8_t {
    Rgb444 = 1U << 0,
    Ycbcr444 = 1U << 1,
    Ycbcr422 = 1U << 2,
    Ycbcr420 = 1U << 3,
};

struct MseOutputCapabilities {
    bool edid_valid = false;
    bool hdr_support = false;
    bool pq_eotf = false;
    bool hlg_eotf = false;
    bool bt2020 = false;
    bool supports_4k50_60 = false;
    std::uint8_t color_space_mask =
        static_cast<std::uint8_t>(MseOutputColorSpace::Rgb444);
    std::uint8_t max_deep_color_bits = 8;
    std::uint32_t max_tmds_clock_mhz = 0;

    bool supports_color_space(const MseOutputColorSpace color_space) const noexcept {
        return (color_space_mask & static_cast<std::uint8_t>(color_space)) != 0;
    }
    bool operator==(const MseOutputCapabilities&) const = default;
};

// Parse the standard EDID base block and CTA-861 extension capability blocks.
// Unknown vendor blocks are ignored; no vendor-specific enum values are guessed.
MseOutputCapabilities parse_mse_output_capabilities(
    std::span<const std::uint8_t> edid) noexcept;

} // namespace tlvdemux
