#pragma once

#include "common.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux::detail::mse {

struct NaluView {
    int type = -1;
    std::size_t offset = 0;
    std::size_t size = 0;
};

struct HevcConfiguration {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::string codec;
    Bytes hvcc;
    std::optional<ColorInformation> source_color;
    std::optional<ColorInformation> color;
    std::optional<HdrStaticMetadata> hdr_static_metadata;
};

enum class HevcColorPolicy {
    Preserve,
    SdrInHlg,
    HlgSdrPrototype,
};

std::vector<NaluView> annex_b_views(const Bytes& data);
Bytes copy_nalu(const Bytes& data, const NaluView& view);
std::optional<HdrStaticMetadata> hdr_static_metadata(const Bytes& data);
HevcConfiguration hevc_configuration(const Bytes& vps, const Bytes& sps,
                                     const Bytes& pps,
                                     HevcColorPolicy color_policy =
                                         HevcColorPolicy::Preserve,
                                     std::optional<HdrStaticMetadata> hdr =
                                         std::nullopt);

} // namespace tlvdemux::detail::mse
