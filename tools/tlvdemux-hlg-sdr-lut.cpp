#include <tlvdemux/hlg_sdr_tone_mapping.hpp>

#include "commands.hpp"

#include <iomanip>
#include <iostream>
#include <string>

namespace {

void usage(std::ostream& output) {
    output << "usage: tlvdemux hlg-sdr-lut [--prototype]\n";
}

double channel(const tlvdemux::HlgSdrColorLut& lut, const std::size_t red,
               const std::size_t green, const std::size_t blue,
               const std::size_t component) {
    const auto offset =
        (green * lut.width + blue * lut.size + red) * 4U + component;
    return static_cast<double>(lut.rgba[offset]) / 255.0;
}

} // namespace

int tlvdemux_cli::run_hlg_sdr_lut(const int argc, char** argv) {
    if (argc == 2 && (std::string(argv[1]) == "-h" ||
                      std::string(argv[1]) == "--help")) {
        usage(std::cout);
        return 0;
    }
    const bool prototype = argc == 2 && std::string(argv[1]) == "--prototype";
    if (argc != 1 && !prototype) {
        usage(std::cerr);
        return 2;
    }

    const auto lut = prototype ? tlvdemux::hlg_sdr_prototype_color_lut()
                               : tlvdemux::hlg_sdr_color_lut();
    std::cout << "TITLE \"tlvdemux HLG-SDR"
              << (prototype ? " prototype" : "") << "\"\n"
                 "LUT_3D_SIZE "
              << lut.size << "\n"
              << "DOMAIN_MIN 0 0 0\n"
                 "DOMAIN_MAX 1 1 1\n";
    std::cout << std::fixed << std::setprecision(9);
    // Iridas .cube order changes red fastest, then green, then blue. The
    // browser texture has a different packed layout, so address it explicitly.
    for (std::size_t blue = 0; blue < lut.size; ++blue) {
        for (std::size_t green = 0; green < lut.size; ++green) {
            for (std::size_t red = 0; red < lut.size; ++red) {
                std::cout << channel(lut, red, green, blue, 0) << ' '
                          << channel(lut, red, green, blue, 1) << ' '
                          << channel(lut, red, green, blue, 2) << '\n';
            }
        }
    }
    return std::cout ? 0 : 2;
}
