#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cmath>

namespace tlvdemux {

inline constexpr std::size_t kHlgSdrToneMappingLutSize = 1024;

namespace detail {

struct HlgSdrToneMappingPoint {
    double input;
    double output;
};

inline constexpr std::array<HlgSdrToneMappingPoint, 6> kHlgSdrToneMappingPoints{{
    {0.00, 0.00},
    {0.40, 0.40},
    {0.75, 0.90},
    // Keep the glow shoulder below hard clipping instead of turning every
    // value above the 79% point into white.
    {0.79, 0.98},
    {0.90, 0.995},
    {1.00, 1.00},
}};

constexpr double clamp01(const double value) {
    return value < 0.0 ? 0.0 : value > 1.0 ? 1.0 : value;
}

constexpr double map_hlg_sdr_signal(const double value) {
    const double input = clamp01(value);
    for (std::size_t index = 1; index < kHlgSdrToneMappingPoints.size(); ++index) {
        const auto& upper = kHlgSdrToneMappingPoints[index];
        if (input <= upper.input) {
            const auto& lower = kHlgSdrToneMappingPoints[index - 1];
            const double ratio = (input - lower.input) /
                (upper.input - lower.input);
            return clamp01(lower.output + ratio * (upper.output - lower.output));
        }
    }
    return 1.0;
}

// The reference player keeps the HLG/SDR 75% white anchor but lifts the
// lower SDR-like range. This is deliberately applied before the ARIB/ITU
// signal anchors so highlights do not gain a second boost.
inline double lift_hlg_sdr_midtones(const double value) {
    constexpr double pivot = 0.75;
    constexpr double gamma = 0.87;
    const double input = clamp01(value);
    if (input >= pivot) return input;
    return pivot * std::pow(input / pivot, gamma);
}

inline double map_hlg_sdr_display_signal(const double value) {
    return map_hlg_sdr_signal(lift_hlg_sdr_midtones(value));
}

} // namespace detail

// Returns an 8-bit lookup table because the browser video texture exposed to
// WebGL is an 8-bit normalized RGB surface.
constexpr std::array<std::uint8_t, kHlgSdrToneMappingLutSize>
hlg_sdr_tone_mapping_lut() {
    std::array<std::uint8_t, kHlgSdrToneMappingLutSize> lut{};
    for (std::size_t index = 0; index < lut.size(); ++index) {
        const double input = static_cast<double>(index) /
            static_cast<double>(lut.size() - 1);
        const double output = detail::map_hlg_sdr_display_signal(input);
        lut[index] = static_cast<std::uint8_t>(output * 255.0 + 0.5);
    }
    return lut;
}

} // namespace tlvdemux
