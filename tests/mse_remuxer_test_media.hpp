#pragma once

#include <tlvdemux/mse_remuxer.hpp>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

class BitWriter {
public:
    void bits(const std::uint32_t value, const unsigned count) {
        for (unsigned index = 0; index < count; ++index) {
            if ((offset_ & 7U) == 0) data_.push_back(0);
            const auto shift = count - index - 1;
            data_.back() |= static_cast<std::uint8_t>(
                ((value >> shift) & 1U) << (7U - (offset_ & 7U)));
            ++offset_;
        }
    }

    std::vector<std::uint8_t> take() { return std::move(data_); }

private:
    std::vector<std::uint8_t> data_;
    unsigned offset_ = 0;
};

inline void write_ue(BitWriter& writer, const std::uint32_t value) {
    const auto code_num = value + 1;
    unsigned leading_zeros = 0;
    while ((code_num >> leading_zeros) > 1) ++leading_zeros;
    for (unsigned index = 0; index < leading_zeros; ++index) writer.bits(0, 1);
    writer.bits(code_num, leading_zeros + 1);
}

inline std::uint16_t nal_header(const unsigned type) {
    return static_cast<std::uint16_t>((type & 0x3fU) << 9 | 1U);
}

inline std::vector<std::uint8_t> nal_header_bytes(const unsigned type) {
    const auto value = nal_header(type);
    return {static_cast<std::uint8_t>(value >> 8), static_cast<std::uint8_t>(value)};
}

inline std::vector<std::uint8_t> make_simple_nal(
    const unsigned type, const std::vector<std::uint8_t>& payload) {
    auto out = nal_header_bytes(type);
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

inline std::vector<std::uint8_t> escape_rbsp(const std::vector<std::uint8_t>& raw) {
    std::vector<std::uint8_t> out;
    unsigned zero_run = 0;
    for (const auto byte : raw) {
        if (zero_run >= 2 && byte <= 3) {
            out.push_back(3);
            zero_run = 0;
        }
        out.push_back(byte);
        zero_run = byte == 0 ? zero_run + 1 : 0;
    }
    return out;
}

inline std::vector<std::uint8_t> build_sps_nalu(
    const std::uint32_t width, const std::uint32_t height,
    const std::uint8_t transfer = 18) {
    BitWriter writer;
    writer.bits(nal_header(33), 16);
    writer.bits(0, 4);
    writer.bits(0, 3);
    writer.bits(1, 1);
    writer.bits(0, 2);
    writer.bits(0, 1);
    writer.bits(1, 5);
    for (int index = 0; index < 4; ++index) writer.bits(0, 8);
    for (int index = 0; index < 6; ++index) writer.bits(0, 8);
    writer.bits(93, 8);
    write_ue(writer, 0);
    write_ue(writer, 1);
    write_ue(writer, width);
    write_ue(writer, height);
    writer.bits(0, 1);
    write_ue(writer, 0);
    write_ue(writer, 0);
    write_ue(writer, 4);
    writer.bits(0, 1);
    write_ue(writer, 0);
    write_ue(writer, 0);
    write_ue(writer, 0);
    for (int index = 0; index < 6; ++index) write_ue(writer, 0);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(0, 1);
    write_ue(writer, 0);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(1, 1);
    writer.bits(1, 1);
    writer.bits(1, 8);
    writer.bits(0, 1);
    writer.bits(1, 1);
    writer.bits(0, 3);
    writer.bits(0, 1);
    writer.bits(1, 1);
    writer.bits(9, 8);
    writer.bits(transfer, 8);
    writer.bits(9, 8);
    return escape_rbsp(writer.take());
}

inline std::vector<std::uint8_t> annex_b_wrap(
    const std::vector<std::uint8_t>& nalu) {
    std::vector<std::uint8_t> out{0, 0, 0, 1};
    out.insert(out.end(), nalu.begin(), nalu.end());
    return out;
}

inline std::vector<std::uint8_t> video_access_unit_data(
    const bool include_parameter_sets, const std::vector<unsigned>& vcl_types,
    const std::optional<unsigned> trailing_nal = std::nullopt,
    const std::uint8_t transfer = 18) {
    std::vector<std::uint8_t> out;
    if (include_parameter_sets) {
        for (const auto& nalu : {
                 annex_b_wrap(make_simple_nal(32, {0xab, 0xcd})),
                 annex_b_wrap(make_simple_nal(34, {0xab, 0xcd})),
                 annex_b_wrap(build_sps_nalu(1920, 1080, transfer))}) {
            out.insert(out.end(), nalu.begin(), nalu.end());
        }
    }
    for (const auto type : vcl_types) {
        const auto vcl = annex_b_wrap(make_simple_nal(type, {0x80}));
        out.insert(out.end(), vcl.begin(), vcl.end());
    }
    if (trailing_nal) {
        const auto nalu = annex_b_wrap(make_simple_nal(*trailing_nal, {}));
        out.insert(out.end(), nalu.begin(), nalu.end());
    }
    return out;
}

inline std::vector<std::uint8_t> video_access_unit_data(
    const bool include_parameter_sets, const bool keyframe) {
    return video_access_unit_data(
        include_parameter_sets, std::vector<unsigned>{keyframe ? 19U : 1U});
}

inline tlvdemux::AccessUnit hevc_unit(
    const std::uint64_t track_id, const std::int64_t dts_value,
    const std::int64_t pts_value, const bool keyframe,
    const bool include_parameter_sets, const std::uint32_t timescale = 1000000) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_access_unit_data(include_parameter_sets, keyframe);
    unit.dts = {dts_value, timescale};
    unit.pts = {pts_value, timescale};
    unit.random_access = keyframe;
    return unit;
}

inline tlvdemux::AccessUnit hevc_unit_with_transfer(
    const std::uint64_t track_id, const std::int64_t dts_value,
    const std::int64_t pts_value, const bool keyframe,
    const bool include_parameter_sets, const std::uint8_t transfer,
    const std::uint32_t timescale = 1000000) {
    auto unit = hevc_unit(
        track_id, dts_value, pts_value, keyframe, include_parameter_sets, timescale);
    unit.data = video_access_unit_data(
        include_parameter_sets, std::vector<unsigned>{keyframe ? 19U : 1U},
        std::nullopt, transfer);
    return unit;
}

inline tlvdemux::AccessUnit hevc_unit(
    const std::uint64_t track_id, const std::int64_t dts_value,
    const std::int64_t pts_value, const std::vector<unsigned>& vcl_types,
    const bool include_parameter_sets,
    const std::optional<unsigned> trailing_nal = std::nullopt,
    const std::uint32_t timescale = 1000000) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_access_unit_data(
        include_parameter_sets, vcl_types, trailing_nal);
    unit.dts = {dts_value, timescale};
    unit.pts = {pts_value, timescale};
    unit.random_access = std::any_of(
        vcl_types.begin(), vcl_types.end(),
        [](const unsigned type) { return type >= 16 && type <= 21; });
    return unit;
}
