#include <tlvdemux/hlg_sdr_tone_mapping.hpp>

#include <algorithm>
#include <cstdlib>
#include <cmath>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

double lut_channel(const tlvdemux::HlgSdrColorLut& lut,
                   const std::size_t red, const std::size_t green,
                   const std::size_t blue, const std::size_t channel) {
    const auto offset =
        (green * lut.width + blue * lut.size + red) * 4U + channel;
    return static_cast<double>(lut.rgba[offset]) / 255.0;
}

tlvdemux::HlgSdrRgb sample_lut(const tlvdemux::HlgSdrColorLut& lut,
                               const tlvdemux::HlgSdrRgb input) {
    const auto coordinate = [size = lut.size](const double value) {
        return value * static_cast<double>(size - 1U);
    };
    const double red = coordinate(input.red);
    const double green = coordinate(input.green);
    const double blue = coordinate(input.blue);
    const auto red0 = static_cast<std::size_t>(std::floor(red));
    const auto green0 = static_cast<std::size_t>(std::floor(green));
    const auto blue0 = static_cast<std::size_t>(std::floor(blue));
    const auto red1 = std::min(red0 + 1U, lut.size - 1U);
    const auto green1 = std::min(green0 + 1U, lut.size - 1U);
    const auto blue1 = std::min(blue0 + 1U, lut.size - 1U);
    const auto lerp = [](const double lower, const double upper,
                         const double amount) {
        return lower + (upper - lower) * amount;
    };
    const auto channel = [&](const std::size_t index) {
        const auto slice = [&](const std::size_t blue_index) {
            const double lower = lerp(lut_channel(lut, red0, green0, blue_index, index),
                                      lut_channel(lut, red1, green0, blue_index, index),
                                      red - static_cast<double>(red0));
            const double upper = lerp(lut_channel(lut, red0, green1, blue_index, index),
                                      lut_channel(lut, red1, green1, blue_index, index),
                                      red - static_cast<double>(red0));
            return lerp(lower, upper, green - static_cast<double>(green0));
        };
        return lerp(slice(blue0), slice(blue1), blue - static_cast<double>(blue0));
    };
    return {channel(0), channel(1), channel(2)};
}

} // namespace

int main() {
    using tlvdemux::detail::map_hlg_sdr_signal;
    using tlvdemux::detail::map_hlg_sdr_display_signal;

    check(map_hlg_sdr_signal(0.0) == 0.0, "black anchor changed");
    check(map_hlg_sdr_signal(0.4) == 0.4, "40% anchor changed");
    check(map_hlg_sdr_signal(0.75) == 0.84, "75% anchor changed");
    check(map_hlg_sdr_signal(0.79) == 0.94, "79% shoulder changed");
    check(map_hlg_sdr_signal(0.90) == 0.985, "90% shoulder changed");
    check(map_hlg_sdr_signal(1.0) == 1.0, "100% shoulder changed");
    check(map_hlg_sdr_display_signal(0.40) == 0.40,
          "measured SDR correction unexpectedly lifts midtones");

    const auto lut = tlvdemux::hlg_sdr_tone_mapping_lut();
    check(lut.front() == 0 && lut.back() == 255, "LUT endpoints changed");
    for (std::size_t index = 1; index < lut.size(); ++index) {
        check(lut[index] >= lut[index - 1], "LUT is not monotonic");
    }

    const auto black = tlvdemux::detail::map_hlg_sdr_display_rgb({0.0, 0.0, 0.0});
    check(black.red == 0.0 && black.green == 0.0 && black.blue == 0.0,
          "RGB mapper changed black");
    const auto neutral = tlvdemux::detail::map_hlg_sdr_display_rgb({0.5, 0.5, 0.5});
    check(neutral.red == neutral.green && neutral.green == neutral.blue,
          "RGB mapper tinted neutral grey");
    const auto colour = tlvdemux::detail::map_hlg_sdr_display_rgb({0.8, 0.4, 0.2});
    check(colour.red / colour.green == 2.0 && colour.green / colour.blue == 2.0,
          "RGB mapper changed unclipped RGB ratios");

    const auto color_lut = tlvdemux::hlg_sdr_color_lut();
    check(color_lut.size == tlvdemux::kHlgSdrColorLutSize,
          "3D LUT size changed");
    check(color_lut.width == color_lut.size * color_lut.size &&
              color_lut.height == color_lut.size,
          "3D LUT texture layout is invalid");
    check(color_lut.rgba.size() == color_lut.width * color_lut.height * 4U,
          "3D LUT byte count is invalid");
    check(color_lut.rgba[0] == 0U && color_lut.rgba[1] == 0U &&
              color_lut.rgba[2] == 0U && color_lut.rgba[3] == 255U,
          "3D LUT black entry changed");
    const auto white = color_lut.rgba.size() - 4U;
    check(color_lut.rgba[white] == 255U && color_lut.rgba[white + 1U] == 255U &&
              color_lut.rgba[white + 2U] == 255U &&
              color_lut.rgba[white + 3U] == 255U,
          "3D LUT white entry changed");
    double maximum_error = 0.0;
    for (unsigned red = 0; red <= 10; ++red) {
        for (unsigned green = 0; green <= 10; ++green) {
            for (unsigned blue = 0; blue <= 10; ++blue) {
                const tlvdemux::HlgSdrRgb input{
                    static_cast<double>(red) / 10.0,
                    static_cast<double>(green) / 10.0,
                    static_cast<double>(blue) / 10.0,
                };
                const auto expected = tlvdemux::detail::map_hlg_sdr_display_rgb(input);
                const auto actual = sample_lut(color_lut, input);
                maximum_error = std::max({maximum_error,
                    std::abs(expected.red - actual.red),
                    std::abs(expected.green - actual.green),
                    std::abs(expected.blue - actual.blue)});
            }
        }
    }
    check(maximum_error <= 3.0 / 255.0,
          "3D LUT interpolation error exceeds three 8-bit levels");

    const std::array<std::pair<double, double>, 4> calibration_points{{
        {0.0886, 0.0315},
        {0.5480, 0.2696},
        {0.9208, 0.7662},
        {0.9368, 0.9256},
    }};
    for (const auto& [input, expected] : calibration_points) {
        check(std::abs(tlvdemux::detail::prototype_sdr_luma_calibration(input) -
                       expected) < 0.02,
              "prototype luma calibration missed a QVC anchor");
    }
    const std::array<std::pair<double, double>, 4> refinement_points{{
        {0.0304, 0.0326},
        {0.2504, 0.2346},
        {0.8403, 0.7528},
        {0.9355, 0.9256},
    }};
    for (const auto& [input, expected] : refinement_points) {
        check(std::abs(tlvdemux::detail::prototype_sdr_luma_refinement(input) -
                       expected) < 0.0001,
              "prototype luma refinement missed a QVC anchor");
    }
    double previous_calibrated = 0.0;
    for (unsigned index = 0; index <= 1000; ++index) {
        const double calibrated =
            tlvdemux::detail::prototype_sdr_luma_refinement(
                tlvdemux::detail::prototype_sdr_luma_calibration(index / 1000.0));
        check(calibrated + 1e-12 >= previous_calibrated,
              "prototype luma calibration is not monotonic");
        previous_calibrated = calibrated;
    }
    check(tlvdemux::detail::prototype_sdr_luma_calibration(0.0) == 0.0 &&
              tlvdemux::detail::prototype_sdr_luma_calibration(1.0) == 1.0,
          "prototype luma calibration changed black or white");
    const double neutral_recovery =
        tlvdemux::detail::prototype_sdr_chroma_luma_recovery(
            {0.5, 0.5, 0.5}, 0.5, 0.25);
    const double saturated_recovery =
        tlvdemux::detail::prototype_sdr_chroma_luma_recovery(
            {0.8, 0.3, 0.1}, 0.5, 0.25);
    check(std::abs(neutral_recovery - 0.25) < 1e-12 &&
              std::abs(saturated_recovery - 0.35) < 1e-12,
          "prototype chroma luma recovery changed neutral pixels or missed saturated pixels");
    const auto prototype_black =
        tlvdemux::detail::map_hlg_sdr_prototype_rgb({0.0, 0.0, 0.0});
    check(prototype_black.red == 0.0 && prototype_black.green == 0.0 &&
              prototype_black.blue == 0.0,
          "prototype mapper changed black");
    const auto prototype_mid =
        tlvdemux::detail::map_hlg_sdr_prototype_rgb({0.5, 0.5, 0.5});
    check(prototype_mid.red > 0.43 && prototype_mid.red < 0.47 &&
              std::abs(prototype_mid.red - prototype_mid.green) < 0.0001 &&
              std::abs(prototype_mid.green - prototype_mid.blue) < 0.0001,
          "prototype mapper does not apply the calibrated mid-grey anchor");
    const auto prototype_reference =
        tlvdemux::detail::map_hlg_sdr_prototype_rgb({0.75, 0.75, 0.75});
    check(prototype_reference.red > 0.82 && prototype_reference.red < 0.87 &&
              std::abs(prototype_reference.red - prototype_reference.green) < 0.0001 &&
              std::abs(prototype_reference.green - prototype_reference.blue) < 0.0001,
          "prototype mapper does not apply the calibrated reference anchor");
    const auto prototype_white =
        tlvdemux::detail::map_hlg_sdr_prototype_rgb({1.0, 1.0, 1.0});
    check(prototype_white.red > 0.995 && prototype_white.green > 0.995 &&
              prototype_white.blue > 0.995,
          "prototype mapper does not fit peak white into the browser canvas");

    const auto prototype_lut = tlvdemux::hlg_sdr_prototype_color_lut();
    check(prototype_lut.size == tlvdemux::kHlgSdrColorLutSize &&
              prototype_lut.rgba.size() ==
                  prototype_lut.width * prototype_lut.height * 4U,
          "prototype 3D LUT layout is invalid");
    const auto prototype_mid_lut = sample_lut(
        prototype_lut, {0.5, 0.5, 0.5});
    check(std::abs(prototype_mid_lut.red - prototype_mid.red) <= 4.0 / 255.0 &&
              std::abs(prototype_mid_lut.green - prototype_mid.green) <= 4.0 / 255.0 &&
              std::abs(prototype_mid_lut.blue - prototype_mid.blue) <= 4.0 / 255.0,
          "prototype LUT interpolation changed its mid-grey output");
    std::cout << "HLG-SDR C++ tone mapping tests passed\n";
}
