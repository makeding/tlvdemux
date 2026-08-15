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

    check(map_hlg_sdr_signal(0.0) == 0.0, "black anchor changed");
    check(map_hlg_sdr_signal(0.4) == 0.4, "40% anchor changed");
    check(map_hlg_sdr_signal(0.75) == 0.9, "75% anchor changed");
    check(map_hlg_sdr_signal(0.79) == 0.98, "79% shoulder changed");
    check(map_hlg_sdr_signal(0.90) == 0.995, "90% shoulder changed");
    check(map_hlg_sdr_signal(1.0) == 1.0, "100% shoulder changed");

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
    std::cout << "HLG-SDR C++ tone mapping tests passed\n";
}
