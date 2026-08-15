#pragma once

#include <array>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace tlvdemux {

inline constexpr std::size_t kHlgSdrToneMappingLutSize = 1024;
inline constexpr std::size_t kHlgSdrColorLutSize = 33;

struct HlgSdrRgb {
    double red;
    double green;
    double blue;
};

struct HlgSdrColorLut {
    std::size_t size;
    std::size_t width;
    std::size_t height;
    std::vector<std::uint8_t> rgba;
};

namespace detail {

struct HlgSdrToneMappingPoint {
    double input;
    double output;
};

inline constexpr std::array<HlgSdrToneMappingPoint, 6> kHlgSdrToneMappingPoints{{
    {0.00, 0.00},
    {0.40, 0.40},
    // Matched QVC CS161/BS4K221 frames place the SDR mid/highlights below the
    // former 0.90/0.98 boost. Preserve the 40% pivot and white point while
    // retaining headroom through the shoulder.
    {0.75, 0.84},
    {0.79, 0.94},
    {0.90, 0.985},
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

inline double map_hlg_sdr_display_signal(const double value) {
    // A ten-minute CS161/BS4K221 match showed that the former unconditional
    // midtone lift made the SDR result brighter than the SDR simulcast.
    return map_hlg_sdr_signal(value);
}

// Keep the colour operation here rather than in individual GPU backends. The
// browser renderers consume the generated 3D LUT and therefore cannot drift
// between per-channel and luminance-based mappings.
inline HlgSdrRgb map_hlg_sdr_display_rgb(const HlgSdrRgb input) {
    const double red = clamp01(input.red);
    const double green = clamp01(input.green);
    const double blue = clamp01(input.blue);
    const double luma = 0.2627 * red + 0.6780 * green + 0.0593 * blue;
    if (luma <= 0.0001) return {0.0, 0.0, 0.0};
    const double scale = map_hlg_sdr_display_signal(luma) / luma;
    return {clamp01(red * scale), clamp01(green * scale),
            clamp01(blue * scale)};
}

inline double inverse_hlg_oetf(const double signal) {
    constexpr double a = 0.17883277;
    constexpr double b = 0.28466892;
    constexpr double c = 0.55991073;
    const double value = clamp01(signal);
    return value <= 0.5 ? value * value / 3.0
                        : (std::exp((value - c) / a) + b) / 12.0;
}

inline HlgSdrRgb multiply(const std::array<double, 9>& matrix,
                          const HlgSdrRgb value) {
    return {
        matrix[0] * value.red + matrix[1] * value.green + matrix[2] * value.blue,
        matrix[3] * value.red + matrix[4] * value.green + matrix[5] * value.blue,
        matrix[6] * value.red + matrix[7] * value.green + matrix[8] * value.blue,
    };
}

inline double prototype_tone_map(const double hdr_luminance) {
    constexpr double k1 = 0.83802;
    constexpr double k2 = 15.09968;
    constexpr double k3 = 0.74204;
    constexpr double k4 = 78.99439;
    constexpr double inflection = 58.5 / k1;
    const double mapped = hdr_luminance < inflection
        ? k1 * hdr_luminance
        : k2 * std::log(hdr_luminance / inflection - k3) + k4;

    // BT.2446 Method C permits SDR super-white up to roughly 120 cd/m2. An
    // 8-bit browser canvas cannot carry that headroom, so smoothly fit only
    // the range above HDR reference white into its remaining nominal range.
    constexpr double reference_white = 90.7;
    constexpr double method_peak = 118.4;
    if (mapped <= reference_white) return clamp01(mapped / 100.0);
    const double ratio = clamp01(
        (mapped - reference_white) / (method_peak - reference_white));
    return reference_white / 100.0 + (1.0 - reference_white / 100.0) *
        (2.0 * ratio - ratio * ratio);
}

inline HlgSdrRgb clip_to_bt709_gamut(const HlgSdrRgb color) {
    return {clamp01(color.red), clamp01(color.green), clamp01(color.blue)};
}

inline double prototype_sdr_luma_calibration(const double luminance) {
    const double input = clamp01(luminance);
    constexpr double contrast = 3.3;
    const double compressed = input /
        (input + contrast * (1.0 - input));

    // QVC CS161/BS4K221 pairs agree at peak white but place the prototype's
    // shadows and midtones too high. Preserve that white point by returning
    // quickly to the identity curve only in the top 1.5% of linear light.
    constexpr double shoulder_start = 0.925;
    constexpr double shoulder_end = 0.940;
    if (input <= shoulder_start) return compressed;
    const double ratio = clamp01(
        (input - shoulder_start) / (shoulder_end - shoulder_start));
    const double blend = ratio * ratio * (3.0 - 2.0 * ratio);
    return compressed + blend * (input - compressed);
}

inline double prototype_sdr_luma_refinement(const double luminance) {
    constexpr std::array<HlgSdrToneMappingPoint, 6> points{{
        {0.0000, 0.0000},
        {0.0304, 0.0326},
        {0.2504, 0.2346},
        {0.8403, 0.7528},
        {0.9355, 0.9256},
        {1.0000, 1.0000},
    }};
    const double input = clamp01(luminance);
    for (std::size_t index = 1; index < points.size(); ++index) {
        if (input <= points[index].input) {
            const auto& lower = points[index - 1];
            const auto& upper = points[index];
            const double ratio = (input - lower.input) /
                (upper.input - lower.input);
            return lower.output + ratio * (upper.output - lower.output);
        }
    }
    return 1.0;
}

inline double prototype_sdr_chroma_luma_recovery(
    const HlgSdrRgb color, const double original_luma,
    const double calibrated_luma) {
    const double maximum = std::max({color.red, color.green, color.blue});
    const double minimum = std::min({color.red, color.green, color.blue});
    const double saturation = maximum > 0.0 ? (maximum - minimum) / maximum : 0.0;
    const double ratio = clamp01((saturation - 0.25) / 0.40);
    const double chroma_weight = ratio * ratio * (3.0 - 2.0 * ratio);
    const double highlight_ratio = clamp01((original_luma - 0.75) / 0.20);
    const double highlight_weight = highlight_ratio * highlight_ratio *
        (3.0 - 2.0 * highlight_ratio);
    const double recovery = 0.20 + 0.80 * highlight_weight;
    return calibrated_luma + recovery * chroma_weight *
        (original_luma - calibrated_luma);
}

inline double srgb_oetf(const double linear) {
    const double value = clamp01(linear);
    return value <= 0.0031308 ? 12.92 * value
                              : 1.055 * std::pow(value, 1.0 / 2.4) - 0.055;
}

// Prototype conversion for an internal 1/13/9 carrier sample entry. The
// browser performs limited-range BT.2020-NCL YUV to RGB', while the carrier
// primaries/transfer keep those HLG code values numerically unchanged for the
// GPU texture. This function then applies BT.2100 HLG display rendering and
// the fixed BT.2446 Method C conversion before producing an sRGB canvas value.
inline HlgSdrRgb map_hlg_sdr_prototype_rgb(const HlgSdrRgb input) {
    const HlgSdrRgb scene{
        inverse_hlg_oetf(input.red), inverse_hlg_oetf(input.green),
        inverse_hlg_oetf(input.blue),
    };
    const double scene_luma =
        0.2627 * scene.red + 0.6780 * scene.green + 0.0593 * scene.blue;
    if (scene_luma <= 0.0) return {0.0, 0.0, 0.0};
    const double ootf_scale = 1000.0 * std::pow(scene_luma, 0.2);
    HlgSdrRgb display{
        scene.red * ootf_scale, scene.green * ootf_scale,
        scene.blue * ootf_scale,
    };

    constexpr double crosstalk = 0.0;
    const double sum = display.red + display.green + display.blue;
    display = {
        (1.0 - 3.0 * crosstalk) * display.red + crosstalk * sum,
        (1.0 - 3.0 * crosstalk) * display.green + crosstalk * sum,
        (1.0 - 3.0 * crosstalk) * display.blue + crosstalk * sum,
    };

    constexpr std::array<double, 9> bt2020_to_xyz{
        0.6370, 0.1446, 0.1689,
        0.2627, 0.6780, 0.0593,
        0.0000, 0.0281, 1.0610,
    };
    constexpr std::array<double, 9> xyz_to_bt2020{
        1.7167, -0.3557, -0.2534,
        -0.6667, 1.6165, 0.0158,
        0.0176, -0.0428, 0.9421,
    };
    auto xyz = multiply(bt2020_to_xyz, display);
    if (xyz.green <= 0.0) return {0.0, 0.0, 0.0};
    const double scale = 100.0 * prototype_tone_map(xyz.green) / xyz.green;
    xyz = {xyz.red * scale, xyz.green * scale, xyz.blue * scale};
    auto sdr2020 = multiply(xyz_to_bt2020, xyz);

    const double inverse = 1.0 / (1.0 - 3.0 * crosstalk);
    const double sdr_sum = sdr2020.red + sdr2020.green + sdr2020.blue;
    sdr2020 = {
        inverse * ((1.0 - crosstalk) * sdr2020.red - crosstalk *
                   (sdr_sum - sdr2020.red)),
        inverse * ((1.0 - crosstalk) * sdr2020.green - crosstalk *
                   (sdr_sum - sdr2020.green)),
        inverse * ((1.0 - crosstalk) * sdr2020.blue - crosstalk *
                   (sdr_sum - sdr2020.blue)),
    };
    sdr2020 = {sdr2020.red / 100.0, sdr2020.green / 100.0,
               sdr2020.blue / 100.0};

    constexpr std::array<double, 9> bt2020_to_bt709{
        1.660491, -0.587641, -0.072850,
        -0.124550, 1.132900, -0.008350,
        -0.018151, -0.100579, 1.118730,
    };
    auto sdr709 = multiply(bt2020_to_bt709, sdr2020);
    const double sdr_luma =
        0.2126 * sdr709.red + 0.7152 * sdr709.green + 0.0722 * sdr709.blue;
    if (sdr_luma <= 0.0) return {0.0, 0.0, 0.0};
    double calibrated_luma = prototype_sdr_luma_refinement(
        prototype_sdr_luma_calibration(sdr_luma));
    calibrated_luma = prototype_sdr_chroma_luma_recovery(
        sdr709, sdr_luma, calibrated_luma);
    const double calibrated_scale = calibrated_luma / sdr_luma;
    sdr709 = clip_to_bt709_gamut({
        sdr709.red * calibrated_scale,
        sdr709.green * calibrated_scale,
        sdr709.blue * calibrated_scale,
    });
    return {srgb_oetf(sdr709.red), srgb_oetf(sdr709.green),
            srgb_oetf(sdr709.blue)};
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

// Blue slices are laid out horizontally. Each slice is size x size with red
// along x and green along y. Both WebGL and WebGPU can perform the same
// trilinear lookup by bilinearly sampling two adjacent blue slices.
inline HlgSdrColorLut hlg_sdr_color_lut() {
    constexpr auto size = kHlgSdrColorLutSize;
    const auto width = size * size;
    std::vector<std::uint8_t> rgba(width * size * 4U);
    for (std::size_t green = 0; green < size; ++green) {
        for (std::size_t blue = 0; blue < size; ++blue) {
            for (std::size_t red = 0; red < size; ++red) {
                const auto mapped = detail::map_hlg_sdr_display_rgb({
                    static_cast<double>(red) / static_cast<double>(size - 1U),
                    static_cast<double>(green) / static_cast<double>(size - 1U),
                    static_cast<double>(blue) / static_cast<double>(size - 1U),
                });
                const auto offset = (green * width + blue * size + red) * 4U;
                rgba[offset] = static_cast<std::uint8_t>(mapped.red * 255.0 + 0.5);
                rgba[offset + 1U] =
                    static_cast<std::uint8_t>(mapped.green * 255.0 + 0.5);
                rgba[offset + 2U] =
                    static_cast<std::uint8_t>(mapped.blue * 255.0 + 0.5);
                rgba[offset + 3U] = 255U;
            }
        }
    }
    return {size, width, size, std::move(rgba)};
}

inline HlgSdrColorLut hlg_sdr_prototype_color_lut() {
    constexpr auto size = kHlgSdrColorLutSize;
    const auto width = size * size;
    std::vector<std::uint8_t> rgba(width * size * 4U);
    for (std::size_t green = 0; green < size; ++green) {
        for (std::size_t blue = 0; blue < size; ++blue) {
            for (std::size_t red = 0; red < size; ++red) {
                const auto mapped = detail::map_hlg_sdr_prototype_rgb({
                    static_cast<double>(red) / static_cast<double>(size - 1U),
                    static_cast<double>(green) / static_cast<double>(size - 1U),
                    static_cast<double>(blue) / static_cast<double>(size - 1U),
                });
                const auto offset = (green * width + blue * size + red) * 4U;
                rgba[offset] = static_cast<std::uint8_t>(mapped.red * 255.0 + 0.5);
                rgba[offset + 1U] =
                    static_cast<std::uint8_t>(mapped.green * 255.0 + 0.5);
                rgba[offset + 2U] =
                    static_cast<std::uint8_t>(mapped.blue * 255.0 + 0.5);
                rgba[offset + 3U] = 255U;
            }
        }
    }
    return {size, width, size, std::move(rgba)};
}

} // namespace tlvdemux
