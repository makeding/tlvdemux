#include "mse/mp4_builder.hpp"
#include <tlvdemux/mse_remuxer.hpp>

#include <tlvdemux/playback.hpp>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <utility>
#include <vector>

// The MseRemuxer fixture helpers are intentionally local to this focused test;
// do not include the large legacy mse_remuxer_tests.cpp translation unit.

using tlvdemux::detail::mse::Bytes;
using tlvdemux::detail::mse::Mp4Track;
using tlvdemux::detail::mse::Sample;

namespace {
struct Box { std::size_t payload; std::size_t end; };
struct TestSink final : tlvdemux::MseSink {
    std::vector<tlvdemux::MseMediaSegment> segments;
    void onMseInit(tlvdemux::MseTrackInit&&) override {}
    void onMseSegment(tlvdemux::MseMediaSegment&& value) override {
        segments.push_back(std::move(value));
    }
};

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

void write_ue(BitWriter& writer, const std::uint32_t value) {
    const auto code_num = value + 1;
    unsigned leading_zeros = 0;
    while ((code_num >> leading_zeros) > 1) ++leading_zeros;
    for (unsigned index = 0; index < leading_zeros; ++index) writer.bits(0, 1);
    writer.bits(code_num, leading_zeros + 1);
}

std::vector<std::uint8_t> escape_rbsp(const std::vector<std::uint8_t>& raw) {
    std::vector<std::uint8_t> output;
    unsigned zero_run = 0;
    for (const auto byte : raw) {
        if (zero_run >= 2 && byte <= 3) {
            output.push_back(3);
            zero_run = 0;
        }
        output.push_back(byte);
        zero_run = byte == 0 ? zero_run + 1 : 0;
    }
    return output;
}

std::vector<std::uint8_t> nalu(
    const unsigned type, const std::vector<std::uint8_t>& payload) {
    std::vector<std::uint8_t> output{
        0, 0, 0, 1, static_cast<std::uint8_t>(type << 1U), 1};
    output.insert(output.end(), payload.begin(), payload.end());
    return output;
}

std::vector<std::uint8_t> sps() {
    BitWriter writer;
    writer.bits(0, 4);  // sps_video_parameter_set_id
    writer.bits(0, 3);  // sps_max_sub_layers_minus1
    writer.bits(1, 1);  // sps_temporal_id_nesting_flag
    writer.bits(0, 2);  // general_profile_space
    writer.bits(0, 1);  // general_tier_flag
    writer.bits(1, 5);  // general_profile_idc
    for (int index = 0; index < 4; ++index) writer.bits(0, 8);
    for (int index = 0; index < 6; ++index) writer.bits(0, 8);
    writer.bits(93, 8);  // general_level_idc
    write_ue(writer, 0);     // sps_seq_parameter_set_id
    write_ue(writer, 1);     // chroma_format_idc
    write_ue(writer, 1920);  // pic_width_in_luma_samples
    write_ue(writer, 1080);  // pic_height_in_luma_samples
    writer.bits(0, 1);       // conformance_window_flag
    write_ue(writer, 0);     // bit_depth_luma_minus8
    write_ue(writer, 0);     // bit_depth_chroma_minus8
    write_ue(writer, 4);     // log2_max_pic_order_cnt_lsb_minus4
    writer.bits(0, 1);       // sps_sub_layer_ordering_info_present_flag
    write_ue(writer, 0);
    write_ue(writer, 0);
    write_ue(writer, 0);
    for (int index = 0; index < 6; ++index) write_ue(writer, 0);
    writer.bits(0, 1);  // scaling_list_enabled_flag
    writer.bits(0, 1);  // amp_enabled_flag
    writer.bits(0, 1);  // sample_adaptive_offset_enabled_flag
    writer.bits(0, 1);  // pcm_enabled_flag
    write_ue(writer, 0);  // num_short_term_ref_pic_sets
    writer.bits(0, 1);  // long_term_ref_pics_present_flag
    writer.bits(0, 1);  // sps_temporal_mvp_enabled_flag
    writer.bits(0, 1);  // strong_intra_smoothing_enabled_flag
    writer.bits(1, 1);  // vui_parameters_present_flag
    writer.bits(1, 1);  // aspect_ratio_info_present_flag
    writer.bits(1, 8);  // aspect_ratio_idc: square
    writer.bits(0, 1);  // overscan_info_present_flag
    writer.bits(1, 1);  // video_signal_type_present_flag
    writer.bits(0, 3);  // video_format
    writer.bits(0, 1);  // video_full_range_flag
    writer.bits(1, 1);  // colour_description_present_flag
    writer.bits(9, 8);  // BT.2020 primaries
    writer.bits(18, 8); // HLG transfer
    writer.bits(9, 8);  // BT.2020 non-constant matrix
    return escape_rbsp(writer.take());
}

// Small valid parameter sets accepted by the HEVC parser (VPS/PPS carry opaque
// payloads; SPS is the compact fixture used by the parser's required fields).
std::vector<std::uint8_t> video_data(const bool parameter_sets, const bool idr) {
    std::vector<std::uint8_t> data;
    if (parameter_sets) {
        for (const auto& part : {nalu(32, {0xab, 0xcd}),
                                 nalu(34, {0xab, 0xcd}), nalu(33, sps())}) {
            data.insert(data.end(), part.begin(), part.end());
        }
    }
    const auto picture = nalu(idr ? 19U : 1U, {0x80});
    data.insert(data.end(), picture.begin(), picture.end());
    return data;
}

tlvdemux::AccessUnit hevc_unit(const std::uint64_t track, const std::int64_t dts,
                               const std::int64_t pts, const bool idr,
                               const bool parameter_sets, const std::uint32_t timescale) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_data(parameter_sets, idr);
    unit.dts = {dts, timescale};
    unit.pts = {pts, timescale};
    unit.random_access = idr;
    return unit;
}

struct ParsedSegment {
    std::uint64_t tfdt = 0;
    std::vector<std::uint32_t> durations;
    std::vector<std::int32_t> offsets;
};
Box child(const Bytes&, std::size_t, std::size_t, const char*);
std::uint32_t u32(const Bytes&, std::size_t);
std::int32_t i32(const Bytes&, std::size_t);
std::vector<ParsedSegment> segments_of(const std::vector<tlvdemux::MseMediaSegment>& segments,
                                       const char* type) {
    std::vector<ParsedSegment> result;
    for (const auto& media : segments) {
        if (media.type != type) continue;
        const auto moof = child(media.data, 0, media.data.size(), "moof");
        const auto traf = child(media.data, moof.payload, moof.end, "traf");
        const auto tfdt = child(media.data, traf.payload, traf.end, "tfdt");
        const auto trun = child(media.data, traf.payload, traf.end, "trun");
        ParsedSegment parsed;
        parsed.tfdt = (std::uint64_t(u32(media.data, tfdt.payload + 4)) << 32) |
                      u32(media.data, tfdt.payload + 8);
        const auto count = u32(media.data, trun.payload + 4);
        for (std::uint32_t index = 0; index < count; ++index) {
            const auto entry = trun.payload + 12 + index * 16;
            parsed.durations.push_back(u32(media.data, entry));
            parsed.offsets.push_back(i32(media.data, entry + 12));
        }
        result.push_back(std::move(parsed));
    }
    return result;
}

std::vector<std::int64_t> composition_timestamps(const std::vector<ParsedSegment>& segments) {
    std::vector<std::int64_t> result;
    for (const auto& segment : segments) {
        auto dts = static_cast<std::int64_t>(segment.tfdt);
        for (std::size_t index = 0; index < segment.offsets.size(); ++index) {
            result.push_back(dts + segment.offsets[index]);
            dts += segment.durations[index];
        }
    }
    return result;
}

void check(const bool condition, const char* message) {
    if (!condition) { std::cerr << "FAIL: " << message << '\n'; std::exit(1); }
}

std::uint32_t u32(const Bytes& data, const std::size_t p) {
    return (std::uint32_t(data[p]) << 24) | (std::uint32_t(data[p + 1]) << 16) |
           (std::uint32_t(data[p + 2]) << 8) | std::uint32_t(data[p + 3]);
}
std::int32_t i32(const Bytes& data, const std::size_t p) {
    return static_cast<std::int32_t>(u32(data, p));
}

Box child(const Bytes& data, const std::size_t begin, const std::size_t end, const char* name) {
    for (std::size_t p = begin; p + 8 <= end;) {
        const auto size = u32(data, p);
        check(size >= 8 && p + size <= end, "invalid MP4 box");
        bool match = true;
        for (int i = 0; i < 4; ++i) match = match && data[p + 4 + i] == name[i];
        if (match) return {p + 8, p + size};
        p += size;
    }
    check(false, "missing MP4 box");
    return {};
}

void test_non_uniform_pts_and_signed_offsets() {
    Mp4Track track;
    track.video = true;
    track.timescale = 180000;
    std::vector<Sample> samples;
    // libaribtlv type-2 recurrence: first DTS is -dts_pts_offset, then each
    // DTS is accumulated PTS minus that AU's dts_pts_offset; PTS is advanced
    // by the per-AU pts_offset.  This vector intentionally has non-uniform
    // PTS offsets (6006, 0, 3003) while DTS remains monotonic.
    // The remuxer's existing timeline offset shifts the recurrence by 3003
    // ticks before fMP4 serialization.
    const std::vector<std::int64_t> dts{0, 3003, 6006};
    const std::vector<std::int64_t> pts{9009, 9009, 12012};
    for (int i = 0; i < 3; ++i) {
        samples.push_back({Bytes{static_cast<std::uint8_t>(i + 1)}, dts[i], pts[i],
                           3003, i == 0});
    }
    const auto segment = tlvdemux::detail::mse::media_segment(track, samples, 7);
    const auto moof = child(segment, 0, segment.size(), "moof");
    const auto traf = child(segment, moof.payload, moof.end, "traf");
    const auto tfdt = child(segment, traf.payload, traf.end, "tfdt");
    const auto trun = child(segment, traf.payload, traf.end, "trun");
    check(segment[tfdt.payload] == 1, "tfdt must use version 1");
    check((std::uint64_t(u32(segment, tfdt.payload + 4)) << 32 |
           u32(segment, tfdt.payload + 8)) == 0, "tfdt did not preserve first DTS");
    check(segment[trun.payload] == 1, "trun must use signed-offset version 1");
    check(u32(segment, trun.payload + 4) == 3, "sample count changed");
    const auto entries = trun.payload + 12;
    for (int i = 0; i < 3; ++i) {
        check(u32(segment, entries + i * 16) == 3003, "duration changed");
        const auto expected = samples[i].pts - samples[i].dts;
        check(i32(segment, entries + i * 16 + 12) == expected,
              "signed composition offset did not preserve PTS-DTS");
    }
}

// The public MseRemuxer applies this exact non-negative timeline shift before
// calling media_segment().  The direct builder test pins the downstream
// boundary: an unshifted negative first DTS must never reach fMP4 output.
void test_negative_decode_timestamp_is_rejected_before_output() {
    Mp4Track track;
    bool rejected = false;
    try {
        tlvdemux::detail::mse::media_segment(track,
            {Sample{Bytes{1}, -1, 0, 1, true}}, 1);
    } catch (const std::runtime_error&) { rejected = true; }
    check(rejected, "negative decode timestamp was emitted instead of being shifted upstream");
}

void test_remuxer_shifts_negative_type2_first_dts() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    const std::vector<std::int64_t> dts{-3003, 0, 3003};
    const std::vector<std::int64_t> pts{6006, 6006, 9009};
    for (std::size_t i = 0; i < dts.size(); ++i) {
        remuxer.push(hevc_unit(2, dts[i], pts[i], i == 0, i == 0, 180000));
    }
    remuxer.flush();
    const auto segments = segments_of(sink.segments, "video");
    check(!segments.empty() && segments.front().tfdt == 0,
          "MseRemuxer did not shift the negative first DTS to tfdt zero");
    check(composition_timestamps(segments) == std::vector<std::int64_t>{9009, 9009, 12012},
          "MseRemuxer did not preserve type-2 PTS after timeline shift");
    std::size_t count = 0;
    for (const auto& segment : segments) count += segment.offsets.size();
    check(count == 3, "MseRemuxer dropped a type-2 access unit");
}

void test_seek_generation_contract() {
    tlvdemux::PlaybackStateMachine state;
    tlvdemux::SourceCapabilities capabilities;
    capabilities.random_access = true;
    check(state.beginOpen(capabilities, tlvdemux::SeekPolicy::AdaptiveRangeProbe) &&
              state.completeOpen(), "could not open playback state");
    const auto first = state.requestSeek();
    const auto second = state.requestSeek();
    check(first && second && *second > *first, "seek generation did not advance");
    check(!state.beginReposition(*first) && state.beginReposition(*second),
          "stale generation was accepted");
}
} // namespace

int main() {
    test_non_uniform_pts_and_signed_offsets();
    test_negative_decode_timestamp_is_rejected_before_output();
    test_remuxer_shifts_negative_type2_first_dts();
    test_seek_generation_contract();
    std::cout << "timestamp fMP4 tests passed\n";
}
