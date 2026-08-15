#include <tlvdemux/hlg_sdr_tone_mapping.hpp>

#include <cstdlib>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

} // namespace

int main() {
    using tlvdemux::detail::map_hlg_sdr_signal;

    check(map_hlg_sdr_signal(0.0) == 0.0, "black anchor changed");
    check(map_hlg_sdr_signal(0.4) == 0.4, "40% anchor changed");
    check(map_hlg_sdr_signal(0.75) == 0.9, "75% anchor changed");
    check(map_hlg_sdr_signal(0.79) == 1.0, "79% anchor changed");
    check(map_hlg_sdr_signal(1.0) == 1.0, "clipped 109% anchor changed");

    const auto lut = tlvdemux::hlg_sdr_tone_mapping_lut();
    check(lut.front() == 0 && lut.back() == 255, "LUT endpoints changed");
    for (std::size_t index = 1; index < lut.size(); ++index) {
        check(lut[index] >= lut[index - 1], "LUT is not monotonic");
    }
    std::cout << "HLG-SDR C++ tone mapping tests passed\n";
}
