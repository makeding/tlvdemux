#include <tlvdemux/output_capabilities.hpp>

#include <algorithm>
#include <array>
#include <cstddef>

namespace {

using tlvdemux::MseOutputCapabilities;
using tlvdemux::MseOutputColorSpace;

bool valid_block(const std::span<const std::uint8_t> edid,
                 const std::size_t offset) noexcept {
    if (offset > edid.size() || edid.size() - offset < 128) return false;
    std::uint8_t checksum = 0;
    for (std::size_t index = 0; index < 128; ++index) {
        checksum = static_cast<std::uint8_t>(checksum + edid[offset + index]);
    }
    return checksum == 0;
}

void parse_cta_block(MseOutputCapabilities& capabilities,
                     const std::span<const std::uint8_t> edid,
                     const std::size_t offset) noexcept {
    if (edid[offset] != 0x02 || edid[offset + 1] < 3) return;
    const auto data_end = edid[offset + 2] == 0
        ? std::size_t{127}
        : static_cast<std::size_t>(edid[offset + 2]);
    if (data_end > 127) return;
    const auto flags = edid[offset + 3];
    if ((flags & 0x20U) != 0) {
        capabilities.color_space_mask |=
            static_cast<std::uint8_t>(MseOutputColorSpace::Ycbcr444);
    }
    if ((flags & 0x10U) != 0) {
        capabilities.color_space_mask |=
            static_cast<std::uint8_t>(MseOutputColorSpace::Ycbcr422);
    }

    std::size_t cursor = offset + 4;
    const auto end = offset + data_end;
    while (cursor < end) {
        const auto header = edid[cursor++];
        const auto tag = static_cast<std::uint8_t>(header >> 5U);
        const auto length = static_cast<std::size_t>(header & 0x1fU);
        if (length > end - cursor) return;
        const auto block_end = cursor + length;
        if (tag == 2) {
            for (; cursor < block_end; ++cursor) {
                const auto vic = static_cast<std::uint8_t>(edid[cursor] & 0x7fU);
                capabilities.supports_4k50_60 =
                    capabilities.supports_4k50_60 || vic == 96 || vic == 97;
            }
            continue;
        }
        if (tag == 3 && length >= 7 && edid[cursor] == 0x03 &&
            edid[cursor + 1] == 0x0c && edid[cursor + 2] == 0x00) {
            const auto features = edid[cursor + 5];
            if ((features & 0x20U) != 0) capabilities.max_deep_color_bits = 10;
            if ((features & 0x40U) != 0) capabilities.max_deep_color_bits = 12;
            if (length >= 7 && edid[cursor + 6] != 0) {
                capabilities.max_tmds_clock_mhz =
                    static_cast<std::uint32_t>(edid[cursor + 6]) * 5U;
            }
        }
        if (tag == 7 && length >= 2) {
            const auto extended_tag = edid[cursor];
            if (extended_tag == 0x06 && length >= 3) {
                const auto eotf = edid[cursor + 1];
                capabilities.pq_eotf = (eotf & 0x04U) != 0;
                capabilities.hlg_eotf = (eotf & 0x08U) != 0;
                capabilities.hdr_support = capabilities.pq_eotf || capabilities.hlg_eotf;
            } else if (extended_tag == 0x05 && length >= 3) {
                const auto colorimetry = edid[cursor + 1];
                capabilities.bt2020 = (colorimetry & 0xc0U) != 0;
            } else if (extended_tag == 0x0e) {
                capabilities.color_space_mask |=
                    static_cast<std::uint8_t>(MseOutputColorSpace::Ycbcr420);
            }
        }
        cursor = block_end;
    }
}

} // namespace

tlvdemux::MseOutputCapabilities tlvdemux::parse_mse_output_capabilities(
    const std::span<const std::uint8_t> edid) noexcept {
    constexpr std::array<std::uint8_t, 8> kEdidHeader{
        0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00};
    MseOutputCapabilities capabilities;
    if (edid.size() < 128 ||
        !std::equal(kEdidHeader.begin(), kEdidHeader.end(), edid.begin())) {
        return capabilities;
    }
    if (!valid_block(edid, 0)) return capabilities;
    const auto extension_count = static_cast<std::size_t>(edid[126]);
    if (extension_count > (edid.size() - 128) / 128) return capabilities;
    for (std::size_t index = 0; index < extension_count; ++index) {
        if (!valid_block(edid, 128 * (index + 1))) return capabilities;
    }
    capabilities.edid_valid = true;
    for (std::size_t index = 0; index < extension_count; ++index) {
        parse_cta_block(capabilities, edid, 128 * (index + 1));
    }
    return capabilities;
}
