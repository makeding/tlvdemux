#pragma once

#include <tlvdemux/output_capabilities.hpp>

#include <cstdint>

namespace tlvdemux {

struct MseSourceVideoFormat {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t pixel_clock_mhz = 0;
    std::uint8_t bit_depth = 8;
    MseOutputColorSpace preferred_color_space = MseOutputColorSpace::Rgb444;
    MseHdrOutputMode hdr_mode = MseHdrOutputMode::Sdr;
};

struct MseOutputFormatDecision {
    bool supported = false;
    MseOutputColorSpace color_space = MseOutputColorSpace::Rgb444;
    std::uint8_t deep_color_bits = 8;
    MseHdrOutputMode hdr_mode = MseHdrOutputMode::Sdr;
    bool requires_sdr_conversion = false;
    bool operator==(const MseOutputFormatDecision&) const = default;
};

// Select the signal format negotiated by the display path. This does not
// perform pixel conversion; a true requires_sdr_conversion is an instruction
// for the platform/HWC layer to provide that conversion.
MseOutputFormatDecision decide_mse_output_format(
    const MseSourceVideoFormat& source,
    const MseOutputCapabilities& sink,
    const MseDolbyTunnelCapabilities& dolby,
    MseHdrOutputMode requested_mode = MseHdrOutputMode::Auto) noexcept;

} // namespace tlvdemux
