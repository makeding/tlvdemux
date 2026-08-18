#include <tlvdemux/output_format.hpp>

#include <cstdlib>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

tlvdemux::MseOutputCapabilities sink() {
    tlvdemux::MseOutputCapabilities result;
    result.edid_valid = true;
    result.hlg_eotf = true;
    result.pq_eotf = true;
    result.max_deep_color_bits = 10;
    result.max_tmds_clock_mhz = 600;
    result.color_space_mask = static_cast<std::uint8_t>(
        tlvdemux::MseOutputColorSpace::Rgb444) |
        static_cast<std::uint8_t>(tlvdemux::MseOutputColorSpace::Ycbcr420);
    return result;
}

void test_preserves_supported_source_signal() {
    tlvdemux::MseSourceVideoFormat source;
    source.pixel_clock_mhz = 594;
    source.bit_depth = 12;
    source.preferred_color_space = tlvdemux::MseOutputColorSpace::Ycbcr420;
    source.hdr_mode = tlvdemux::MseHdrOutputMode::Hlg;
    const auto decision = tlvdemux::decide_mse_output_format(
        source, sink(), {}, tlvdemux::MseHdrOutputMode::Auto);
    check(decision.supported && decision.hdr_mode == tlvdemux::MseHdrOutputMode::Hlg,
          "supported HLG source was not preserved");
    check(decision.deep_color_bits == 10 &&
              decision.color_space == tlvdemux::MseOutputColorSpace::Ycbcr420,
          "sink deep-color or colorspace limit was ignored");
}

void test_falls_back_to_platform_conversion() {
    auto capabilities = sink();
    capabilities.hlg_eotf = false;
    tlvdemux::MseSourceVideoFormat source;
    source.hdr_mode = tlvdemux::MseHdrOutputMode::Hlg;
    source.pixel_clock_mhz = 300;
    const auto decision = tlvdemux::decide_mse_output_format(
        source, capabilities, {}, tlvdemux::MseHdrOutputMode::Auto);
    check(decision.supported && decision.hdr_mode == tlvdemux::MseHdrOutputMode::Sdr &&
              decision.requires_sdr_conversion,
          "unsupported HLG output did not request platform conversion");
}

void test_rejects_tmds_overflow() {
    auto source = tlvdemux::MseSourceVideoFormat{};
    source.pixel_clock_mhz = 601;
    check(!tlvdemux::decide_mse_output_format(source, sink(), {},
                                               tlvdemux::MseHdrOutputMode::Auto).supported,
          "pixel clock over MaxTMDS was accepted");
}

} // namespace

int main() {
    test_preserves_supported_source_signal();
    test_falls_back_to_platform_conversion();
    test_rejects_tmds_overflow();
    std::cout << "output format tests passed\n";
}
