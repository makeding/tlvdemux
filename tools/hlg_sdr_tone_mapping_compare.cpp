#include <tlvdemux/hlg_sdr_tone_mapping.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Image {
    std::size_t width = 0;
    std::size_t height = 0;
    std::vector<std::uint8_t> rgb;
};

std::string next_token(std::istream& input) {
    std::string token;
    char character = 0;
    while (input.get(character)) {
        if (character == '#') {
            input.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
        } else if (!std::isspace(static_cast<unsigned char>(character))) {
            token.push_back(character);
            break;
        }
    }
    while (input.get(character) && !std::isspace(static_cast<unsigned char>(character))) {
        if (character == '#') {
            input.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
            break;
        }
        token.push_back(character);
    }
    return token;
}

std::size_t positive_size(const std::string& value, const char* name) {
    char* end = nullptr;
    const auto parsed = std::strtoull(value.c_str(), &end, 10);
    if (end == value.c_str() || *end != '\0' || parsed == 0) {
        throw std::runtime_error(std::string("invalid ") + name);
    }
    return static_cast<std::size_t>(parsed);
}

Image read_ppm(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("cannot open " + path);
    if (next_token(input) != "P6") throw std::runtime_error(path + " is not a P6 PPM");
    const auto width = positive_size(next_token(input), "PPM width");
    const auto height = positive_size(next_token(input), "PPM height");
    if (next_token(input) != "255") throw std::runtime_error(path + " must use maxval 255");
    input.get();
    Image image{width, height, std::vector<std::uint8_t>(width * height * 3)};
    input.read(reinterpret_cast<char*>(image.rgb.data()),
               static_cast<std::streamsize>(image.rgb.size()));
    if (input.gcount() != static_cast<std::streamsize>(image.rgb.size())) {
        throw std::runtime_error(path + " has a truncated pixel payload");
    }
    return image;
}

void write_ppm(const std::string& path, const Image& image) {
    std::ofstream output(path, std::ios::binary);
    if (!output) throw std::runtime_error("cannot write " + path);
    output << "P6\n" << image.width << ' ' << image.height << "\n255\n";
    output.write(reinterpret_cast<const char*>(image.rgb.data()),
                 static_cast<std::streamsize>(image.rgb.size()));
    if (!output) throw std::runtime_error("failed writing " + path);
}

Image apply_lut(const Image& source) {
    const auto lut = tlvdemux::hlg_sdr_tone_mapping_lut();
    Image output = source;
    for (auto& value : output.rgb) {
        const auto index = (static_cast<std::size_t>(value) *
                            (lut.size() - 1) + 127) / 255;
        value = lut[index];
    }
    return output;
}

struct Metrics {
    double rgb_mae = 0.0;
    double luma_mae = 0.0;
    double max_error = 0.0;
    double clipped_ratio = 0.0;
};

Metrics compare(const Image& actual, const Image& reference) {
    if (actual.width != reference.width || actual.height != reference.height) {
        throw std::runtime_error("source and reference dimensions differ");
    }
    Metrics metrics;
    double rgb_error = 0.0;
    double luma_error = 0.0;
    std::size_t clipped = 0;
    for (std::size_t offset = 0; offset < actual.rgb.size(); offset += 3) {
        double actual_luma = 0.0;
        double reference_luma = 0.0;
        for (std::size_t channel = 0; channel < 3; ++channel) {
            const double actual_value = actual.rgb[offset + channel] / 255.0;
            const double reference_value = reference.rgb[offset + channel] / 255.0;
            const double error = std::abs(actual_value - reference_value);
            rgb_error += error;
            metrics.max_error = std::max(metrics.max_error, error);
            actual_luma += actual_value * std::array<double, 3>{0.2627, 0.6780, 0.0593}[channel];
            reference_luma += reference_value *
                std::array<double, 3>{0.2627, 0.6780, 0.0593}[channel];
            if (actual.rgb[offset + channel] == 255 && reference.rgb[offset + channel] < 255) {
                ++clipped;
            }
        }
        luma_error += std::abs(actual_luma - reference_luma);
    }
    const double pixel_count = static_cast<double>(actual.width * actual.height);
    metrics.rgb_mae = rgb_error / static_cast<double>(actual.rgb.size());
    metrics.luma_mae = luma_error / pixel_count;
    metrics.clipped_ratio = static_cast<double>(clipped) /
        static_cast<double>(actual.rgb.size());
    return metrics;
}

struct Options {
    std::string source;
    std::string reference;
    std::optional<std::string> output;
    std::optional<double> max_luma_mae;
};

Options parse_options(const int argc, char** argv) {
    if (argc < 3) {
        throw std::runtime_error(
            "usage: tlvdemux-hlg-sdr-compare SOURCE.ppm REFERENCE.ppm "
            "[--output OUTPUT.ppm] [--max-luma-mae VALUE]");
    }
    Options options{argv[1], argv[2]};
    for (int index = 3; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--output" || argument == "--max-luma-mae") {
            if (++index >= argc) throw std::runtime_error("missing value for " + argument);
            if (argument == "--output") options.output = argv[index];
            else options.max_luma_mae = std::stod(argv[index]);
        } else {
            throw std::runtime_error("unknown option: " + argument);
        }
    }
    return options;
}

} // namespace

int main(const int argc, char** argv) {
    try {
        const auto options = parse_options(argc, argv);
        const auto source = read_ppm(options.source);
        const auto reference = read_ppm(options.reference);
        const auto actual = apply_lut(source);
        const auto metrics = compare(actual, reference);
        if (options.output) write_ppm(*options.output, actual);
        std::cout << std::fixed << std::setprecision(6)
                  << "rgb_mae=" << metrics.rgb_mae
                  << " luma_mae=" << metrics.luma_mae
                  << " max_error=" << metrics.max_error
                  << " clipped_ratio=" << metrics.clipped_ratio << '\n';
        if (options.max_luma_mae && metrics.luma_mae > *options.max_luma_mae) {
            std::cerr << "HLG-SDR comparison failed: luma_mae exceeds threshold\n";
            return 1;
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
