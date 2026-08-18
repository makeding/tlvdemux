#include <tlvdemux/output_capabilities.hpp>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <vector>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void checksum(std::vector<std::uint8_t>& block, const std::size_t offset) {
    std::uint8_t sum = 0;
    for (std::size_t index = 0; index < 127; ++index) {
        sum = static_cast<std::uint8_t>(sum + block[offset + index]);
    }
    block[offset + 127] = static_cast<std::uint8_t>(0U - sum);
}

std::vector<std::uint8_t> make_edid() {
    std::vector<std::uint8_t> edid(256, 0);
    const std::uint8_t header[] = {0x00, 0xff, 0xff, 0xff,
                                   0xff, 0xff, 0xff, 0x00};
    for (std::size_t index = 0; index < sizeof(header); ++index) {
        edid[index] = header[index];
    }
    edid[126] = 1;

    auto& cta = edid;
    cta[128] = 0x02;
    cta[129] = 3;
    cta[130] = 25;
    cta[131] = 0x30; // YCbCr 4:4:4 and 4:2:2.
    std::size_t cursor = 132;
    cta[cursor++] = 0x41; // Video Data Block, one VIC.
    cta[cursor++] = 96;   // 3840x2160p50.
    cta[cursor++] = 0x67; // HDMI VSDB, seven-byte payload.
    cta[cursor++] = 0x03;
    cta[cursor++] = 0x0c;
    cta[cursor++] = 0x00;
    cta[cursor++] = 0x10;
    cta[cursor++] = 0x00;
    cta[cursor++] = 0x20; // 10-bit deep color.
    cta[cursor++] = 120;  // 600 MHz MaxTMDSClock.
    cta[cursor++] = 0xe3; // HDR static metadata extended block, 3 bytes.
    cta[cursor++] = 0x06;
    cta[cursor++] = 0x0c; // SMPTE ST 2084 and HLG EOTFs.
    cta[cursor++] = 0x00;
    cta[cursor++] = 0xe3; // Colorimetry extended block, 3 bytes.
    cta[cursor++] = 0x05;
    cta[cursor++] = 0xc0; // BT.2020 RGB and YCC.
    cta[cursor++] = 0x00;
    cta[cursor++] = 0xe2; // YCbCr 4:2:0 capability map.
    cta[cursor++] = 0x0e;
    cta[cursor++] = 0x01;
    check(cursor == 153, "synthetic CTA data block size changed");
    checksum(edid, 0);
    checksum(edid, 128);
    return edid;
}

void test_cta_capabilities() {
    const auto edid = make_edid();
    const auto capabilities = tlvdemux::parse_mse_output_capabilities(edid);
    check(capabilities.edid_valid, "valid EDID was rejected");
    check(capabilities.hdr_support && capabilities.pq_eotf && capabilities.hlg_eotf,
          "HDR EOTF capabilities were not parsed");
    check(capabilities.bt2020, "BT.2020 colorimetry was not parsed");
    check(capabilities.supports_4k50_60, "4K50/60 VIC was not parsed");
    check(capabilities.max_deep_color_bits == 10,
          "HDMI deep-color capability was not parsed");
    check(capabilities.max_tmds_clock_mhz == 600,
          "MaxTMDSClock was not parsed");
    check(capabilities.supports_color_space(tlvdemux::MseOutputColorSpace::Ycbcr444),
          "YCbCr444 capability was not parsed");
    check(capabilities.supports_color_space(tlvdemux::MseOutputColorSpace::Ycbcr422),
          "YCbCr422 capability was not parsed");
    check(capabilities.supports_color_space(tlvdemux::MseOutputColorSpace::Ycbcr420),
          "YCbCr420 capability was not parsed");
}

void test_bad_checksum_is_rejected() {
    auto edid = make_edid();
    edid[255] ^= 1U;
    check(!tlvdemux::parse_mse_output_capabilities(edid).edid_valid,
          "bad EDID checksum was accepted");
}

} // namespace

int main() {
    test_cta_capabilities();
    test_bad_checksum_is_rejected();
    std::cout << "output capabilities tests passed\n";
}
