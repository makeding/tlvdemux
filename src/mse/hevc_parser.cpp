#include "hevc_parser.hpp"

#include <aribtlv/video_color.hpp>

#include <algorithm>
#include <array>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace tlvdemux::detail::mse {
namespace {

Bytes u16(const std::uint32_t value) {
    return {static_cast<std::uint8_t>(value >> 8U),
            static_cast<std::uint8_t>(value)};
}

template <typename... Parts>
Bytes join(const Parts&... parts) {
    const std::size_t size = (parts.size() + ... + 0U);
    Bytes output;
    output.reserve(size);
    (append(output, parts), ...);
    return output;
}

Bytes rbsp(const Bytes& nalu) {
    Bytes output;
    output.reserve(nalu.size());
    for (std::size_t index = 0; index < nalu.size(); ++index) {
        if (index >= 2 && nalu[index] == 3 && nalu[index - 1] == 0 &&
            nalu[index - 2] == 0) {
            continue;
        }
        output.push_back(nalu[index]);
    }
    return output;
}

std::uint8_t reverse_byte(const std::uint8_t value) {
    std::uint8_t output = 0;
    for (unsigned index = 0; index < 8; ++index) {
        output |= static_cast<std::uint8_t>(
            ((value >> (7U - index)) & 1U) << index);
    }
    return output;
}

struct SpsInfo {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t compatibility = 0;
    std::uint8_t profile_space = 0;
    std::uint8_t tier = 0;
    std::uint8_t profile = 0;
    std::uint8_t level = 0;
    std::uint8_t chroma = 0;
    std::uint8_t bit_luma = 0;
    std::uint8_t bit_chroma = 0;
    std::uint8_t layers = 0;
    std::uint8_t nested = 0;
    Bytes compatibility_bytes;
    Bytes constraints;
    std::string codec;
    std::optional<ColorInformation> color;
    std::optional<std::size_t> color_offset;
};

void skip_scaling_list_data(BitReader& reader) {
    for (unsigned size_id = 0; size_id < 4; ++size_id) {
        const auto matrix_count = size_id == 3 ? 2U : 6U;
        for (unsigned matrix = 0; matrix < matrix_count; ++matrix) {
            if (!reader.boolean()) {
                reader.ue();
                continue;
            }
            const auto coefficient_count = std::min(64U, 1U << (4U + 2U * size_id));
            if (size_id > 1) reader.ue();
            for (unsigned coefficient = 0; coefficient < coefficient_count; ++coefficient) {
                reader.ue();
            }
        }
    }
}

void skip_short_term_reference_picture_set(
    BitReader& reader, const std::uint32_t index,
    std::array<std::uint32_t, 64>& delta_poc_counts) {
    if (index != 0 && reader.boolean()) {
        reader.bits(1);
        reader.ue();
        auto count = 0U;
        for (std::uint32_t delta = 0; delta <= delta_poc_counts[index - 1]; ++delta) {
            const bool used = reader.boolean();
            const bool use_delta = used || reader.boolean();
            if (use_delta) ++count;
        }
        delta_poc_counts[index] = count;
        return;
    }

    const auto negative = reader.ue();
    const auto positive = reader.ue();
    if (negative > 64 || positive > 64 || negative + positive > 64) {
        throw std::runtime_error("HEVC SPS has too many reference pictures");
    }
    delta_poc_counts[index] = negative + positive;
    for (std::uint32_t picture = 0; picture < negative + positive; ++picture) {
        reader.ue();
        reader.bits(1);
    }
}

struct ParsedVuiColor {
    ColorInformation color;
    std::size_t offset = 0;
};

std::optional<ParsedVuiColor> parse_vui_color(BitReader& reader) {
    if (reader.boolean()) {
        const auto aspect_ratio_idc = reader.bits(8);
        if (aspect_ratio_idc == 255) reader.bits(32);
    }
    if (reader.boolean()) reader.bits(1);
    if (!reader.boolean()) return std::nullopt;

    reader.bits(3);
    const bool full_range = reader.boolean();
    if (!reader.boolean()) return std::nullopt;
    const auto offset = reader.offset();
    return ParsedVuiColor{
        ColorInformation{static_cast<std::uint16_t>(reader.bits(8)),
                         static_cast<std::uint16_t>(reader.bits(8)),
                         static_cast<std::uint16_t>(reader.bits(8)), full_range},
        offset,
    };
}

SpsInfo parse_sps(const Bytes& nalu) {
    const auto data = rbsp(nalu);
    BitReader reader(data);
    SpsInfo output;
    reader.bits(16);
    reader.bits(4);
    const auto max_layers = reader.bits(3);
    output.nested = static_cast<std::uint8_t>(reader.boolean());
    output.profile_space = static_cast<std::uint8_t>(reader.bits(2));
    output.tier = static_cast<std::uint8_t>(reader.bits(1));
    output.profile = static_cast<std::uint8_t>(reader.bits(5));
    for (int index = 0; index < 4; ++index) {
        output.compatibility_bytes.push_back(static_cast<std::uint8_t>(reader.bits(8)));
    }
    for (int index = 0; index < 6; ++index) {
        output.constraints.push_back(static_cast<std::uint8_t>(reader.bits(8)));
    }
    output.level = static_cast<std::uint8_t>(reader.bits(8));
    std::vector<bool> sub_profile(max_layers);
    std::vector<bool> sub_level(max_layers);
    for (std::uint32_t index = 0; index < max_layers; ++index) {
        sub_profile[index] = reader.boolean();
        sub_level[index] = reader.boolean();
    }
    if (max_layers > 0) reader.bits((8U - max_layers) * 2U);
    for (std::uint32_t index = 0; index < max_layers; ++index) {
        if (sub_profile[index]) reader.bits(88);
        if (sub_level[index]) reader.bits(8);
    }
    reader.ue();
    output.chroma = static_cast<std::uint8_t>(reader.ue());
    if (output.chroma == 3) reader.bits(1);
    const auto coded_width = reader.ue();
    const auto coded_height = reader.ue();
    std::uint32_t left = 0;
    std::uint32_t right = 0;
    std::uint32_t top = 0;
    std::uint32_t bottom = 0;
    if (reader.boolean()) {
        left = reader.ue();
        right = reader.ue();
        top = reader.ue();
        bottom = reader.ue();
    }
    output.bit_luma = static_cast<std::uint8_t>(reader.ue());
    output.bit_chroma = static_cast<std::uint8_t>(reader.ue());
    const auto log2_max_pic_order_count = reader.ue() + 4U;
    if (log2_max_pic_order_count > 32) {
        throw std::runtime_error("invalid HEVC picture-order count width");
    }
    const auto ordering_start = reader.boolean() ? 0U : max_layers;
    for (auto layer = ordering_start; layer <= max_layers; ++layer) {
        reader.ue();
        reader.ue();
        reader.ue();
    }
    for (unsigned syntax_element = 0; syntax_element < 6; ++syntax_element) {
        reader.ue();
    }
    if (reader.boolean() && reader.boolean()) skip_scaling_list_data(reader);
    reader.bits(1);
    reader.bits(1);
    if (reader.boolean()) {
        reader.bits(8);
        reader.ue();
        reader.ue();
        reader.bits(1);
    }
    const auto short_term_sets = reader.ue();
    if (short_term_sets > 64) {
        throw std::runtime_error("HEVC SPS has too many reference-picture sets");
    }
    std::array<std::uint32_t, 64> delta_poc_counts{};
    for (std::uint32_t index = 0; index < short_term_sets; ++index) {
        skip_short_term_reference_picture_set(reader, index, delta_poc_counts);
    }
    if (reader.boolean()) {
        const auto long_term_pictures = reader.ue();
        if (long_term_pictures > 32) {
            throw std::runtime_error("HEVC SPS has too many long-term reference pictures");
        }
        for (std::uint32_t index = 0; index < long_term_pictures; ++index) {
            reader.bits(log2_max_pic_order_count);
            reader.bits(1);
        }
    }
    reader.bits(1);
    reader.bits(1);
    if (reader.boolean()) {
        const auto vui_color = parse_vui_color(reader);
        if (vui_color) {
            output.color = vui_color->color;
            output.color_offset = vui_color->offset;
        }
    }
    const auto sub_width = output.chroma == 1 || output.chroma == 2 ? 2U : 1U;
    const auto sub_height = output.chroma == 1 ? 2U : 1U;
    output.width = coded_width - sub_width * (left + right);
    output.height = coded_height - sub_height * (top + bottom);
    for (std::size_t index = 0; index < 4; ++index) {
        output.compatibility |= static_cast<std::uint32_t>(
            reverse_byte(output.compatibility_bytes[index])) << (index * 8U);
    }
    const char prefixes[] = {'\0', 'A', 'B', 'C'};
    output.codec = "hvc1.";
    if (prefixes[output.profile_space] != '\0') {
        output.codec += prefixes[output.profile_space];
    }
    output.codec += std::to_string(output.profile) + ".";
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%X.%c%u", output.compatibility,
                  output.tier != 0 ? 'H' : 'L', output.level);
    output.codec += buffer;
    auto last = static_cast<int>(output.constraints.size()) - 1;
    while (last >= 0 && output.constraints[static_cast<std::size_t>(last)] == 0) --last;
    for (int index = 0; index <= last; ++index) {
        std::snprintf(buffer, sizeof(buffer), ".%02X",
                      output.constraints[static_cast<std::size_t>(index)]);
        output.codec += buffer;
    }
    output.layers = static_cast<std::uint8_t>(max_layers + 1U);
    return output;
}

void write_bits(Bytes& data, const std::size_t offset, const unsigned count,
                const std::uint32_t value) {
    for (unsigned index = 0; index < count; ++index) {
        const auto bit = (value >> (count - index - 1U)) & 1U;
        const auto position = offset + index;
        const auto mask = static_cast<std::uint8_t>(1U << (7U - (position & 7U)));
        if (bit != 0) data[position >> 3U] |= mask;
        else data[position >> 3U] &= static_cast<std::uint8_t>(~mask);
    }
}

Bytes escape_rbsp(const Bytes& data) {
    Bytes output;
    output.reserve(data.size());
    unsigned zero_run = 0;
    for (const auto value : data) {
        if (zero_run >= 2 && value <= 3) {
            output.push_back(3);
            zero_run = 0;
        }
        output.push_back(value);
        zero_run = value == 0 ? zero_run + 1U : 0U;
    }
    return output;
}

Bytes rewritten_color_sps(const Bytes& sps, const HevcColorPolicy policy) {
    if (sps.size() < 2) return sps;
    const auto original = parse_sps(sps);
    if (!original.color || !original.color_offset ||
        !aribtlv::is_bt2020_hlg(original.color->primaries,
                                 original.color->transfer,
                                 original.color->matrix,
                                 original.color->full_range)) {
        return sps;
    }
    auto data = rbsp(sps);
    if (policy == HevcColorPolicy::SdrInHlg) {
        // Remove only the HLG transfer declaration. The primaries and matrix
        // remain properties of the coded BT.2020 YUV.
        write_bits(data, *original.color_offset + 8U, 8, 1);
    } else if (policy == HevcColorPolicy::HlgSdrPrototype) {
        // Internal GPU carrier: keep the BT.2020-NCL matrix that reconstructs
        // the coded RGB' values, but advertise matching sRGB primaries and
        // transfer so external-texture sampling does not pre-tone-map HLG.
        write_bits(data, *original.color_offset, 8, 1);
        write_bits(data, *original.color_offset + 8U, 8, 13);
    } else {
        return sps;
    }
    Bytes output{sps.begin(), sps.begin() + 2};
    const Bytes payload(data.begin() + 2, data.end());
    append(output, escape_rbsp(payload));
    return output;
}

Bytes make_hvcc(const Bytes& vps, const Bytes& sps, const Bytes& pps,
                const SpsInfo& info) {
    Bytes header(23, 0);
    header[0] = 1;
    header[1] = static_cast<std::uint8_t>(
        (info.profile_space << 6U) | (info.tier << 5U) | info.profile);
    std::copy(info.compatibility_bytes.begin(), info.compatibility_bytes.end(),
              header.begin() + 2);
    std::copy(info.constraints.begin(), info.constraints.end(), header.begin() + 6);
    header[12] = info.level;
    header[13] = 0xf0;
    header[15] = 0xfc;
    header[16] = static_cast<std::uint8_t>(0xfcU | info.chroma);
    header[17] = static_cast<std::uint8_t>(0xf8U | info.bit_luma);
    header[18] = static_cast<std::uint8_t>(0xf8U | info.bit_chroma);
    header[21] = static_cast<std::uint8_t>(
        (static_cast<unsigned>(info.layers) << 3U) |
        (info.nested != 0 ? 4U : 0U) | 3U);
    header[22] = 3;
    const auto array = [](const std::uint8_t type, const Bytes& nalu) {
        return join(Bytes{static_cast<std::uint8_t>(0x80U | type), 0, 1},
                    u16(static_cast<std::uint32_t>(nalu.size())), nalu);
    };
    return join(header, array(32, vps), array(33, sps), array(34, pps));
}

} // namespace

std::vector<NaluView> annex_b_views(const Bytes& data) {
    struct Start {
        std::size_t data = 0;
        std::size_t code = 0;
    };
    std::vector<Start> starts;
    starts.reserve(16);
    for (std::size_t index = 0; index + 3 < data.size(); ++index) {
        if (data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1) {
            starts.push_back({index + 3, index});
            index += 2;
        } else if (index + 4 < data.size() && data[index] == 0 &&
                   data[index + 1] == 0 && data[index + 2] == 0 &&
                   data[index + 3] == 1) {
            starts.push_back({index + 4, index});
            index += 3;
        }
    }
    std::vector<NaluView> output;
    output.reserve(starts.size());
    for (std::size_t index = 0; index < starts.size(); ++index) {
        const auto end = index + 1 < starts.size() ? starts[index + 1].code : data.size();
        if (end < starts[index].data + 2) continue;
        output.push_back({static_cast<int>((data[starts[index].data] >> 1U) & 0x3fU),
                          starts[index].data, end - starts[index].data});
    }
    return output;
}

Bytes copy_nalu(const Bytes& data, const NaluView& view) {
    if (view.offset > data.size() || view.size > data.size() - view.offset) {
        throw std::runtime_error("HEVC NAL view exceeds access unit");
    }
    return Bytes(data.begin() + static_cast<std::ptrdiff_t>(view.offset),
                 data.begin() + static_cast<std::ptrdiff_t>(view.offset + view.size));
}

HevcConfiguration hevc_configuration(const Bytes& vps, const Bytes& sps,
                                     const Bytes& pps,
                                     const HevcColorPolicy color_policy) {
    const auto source_info = parse_sps(sps);
    const auto effective_sps = rewritten_color_sps(sps, color_policy);
    const auto info = parse_sps(effective_sps);
    return {info.width, info.height, info.codec,
            make_hvcc(vps, effective_sps, pps, info),
            source_info.color, info.color};
}

} // namespace tlvdemux::detail::mse
