#include <tlvdemux/mse_remuxer.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

void check(const bool condition, const std::string& message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

class TestSink final : public tlvdemux::MseSink {
public:
    void onMseInit(tlvdemux::MseTrackInit&& init) override {
        events.push_back("init:" + init.type);
        inits.push_back(std::move(init));
    }
    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        events.push_back("segment:" + segment.type);
        segments.push_back(std::move(segment));
    }
    void onMseAudioSplice(const tlvdemux::MseAudioSplice& splice) override {
        events.push_back("splice");
        splices.push_back(splice);
    }
    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        events.push_back("video-splice");
        video_splices.push_back(splice);
    }
    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        events.push_back("layer-switch");
        layer_switches.push_back(layer);
    }
    void onMseLayerSwitchCancelled(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) override {
        events.push_back("layer-switch-cancelled");
        layer_switch_cancellations.push_back(cancelled);
    }

    std::vector<tlvdemux::MseTrackInit> inits;
    std::vector<tlvdemux::MseMediaSegment> segments;
    std::vector<tlvdemux::MseAudioSplice> splices;
    std::vector<tlvdemux::MseVideoSplice> video_splices;
    std::vector<tlvdemux::MseLayerSwitch> layer_switches;
    std::vector<tlvdemux::MseLayerSwitchCancelled> layer_switch_cancellations;
    std::vector<std::string> events;
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

std::vector<std::uint8_t> loas_frame(const std::uint32_t channel_configuration) {
    BitWriter writer;
    writer.bits(0, 1);  // useSameStreamMux
    writer.bits(0, 1);  // audioMuxVersion
    writer.bits(1, 1);  // allStreamsSameTimeFraming
    writer.bits(0, 6);  // numSubFrames
    writer.bits(0, 4);  // numProgram
    writer.bits(0, 3);  // numLayer
    writer.bits(2, 5);  // AAC LC
    writer.bits(3, 4);  // 48000 Hz
    writer.bits(channel_configuration, 4);
    writer.bits(0, 1);  // frameLengthFlag
    writer.bits(0, 1);  // dependsOnCoreCoder
    writer.bits(0, 1);  // extensionFlag
    writer.bits(0, 3);  // frameLengthType
    writer.bits(0, 8);  // latmBufferFullness
    writer.bits(0, 1);  // otherDataPresent
    writer.bits(0, 1);  // crcCheckPresent
    writer.bits(1, 8);  // PayloadLengthInfo
    writer.bits(0xaa, 8);
    auto payload = writer.take();
    const auto length = payload.size();
    std::vector<std::uint8_t> result{
        0x56,
        static_cast<std::uint8_t>(0xe0U | ((length >> 8U) & 0x1fU)),
        static_cast<std::uint8_t>(length),
    };
    result.insert(result.end(), payload.begin(), payload.end());
    return result;
}

tlvdemux::AccessUnit audio_unit(const std::uint32_t channel_configuration) {
    tlvdemux::AccessUnit unit;
    unit.track_id = 1;
    unit.codec = tlvdemux::Codec::AacLatm;
    unit.data = loas_frame(channel_configuration);
    unit.pts = {0, 48000};
    unit.dts = unit.pts;
    return unit;
}

tlvdemux::AccessUnit audio_unit(const std::uint64_t track_id,
                                const std::int64_t pts_value,
                                const std::uint32_t channel_configuration = 2) {
    auto unit = audio_unit(channel_configuration);
    unit.track_id = track_id;
    unit.pts = {pts_value, 48000};
    unit.dts = unit.pts;
    return unit;
}

// ---- Minimal fMP4 box reader: enough to pull tfdt/trun back out of a
// media segment the muxer just produced, so the tests can inspect the
// exact bytes that would reach a real MSE SourceBuffer. ----

std::uint32_t read_u32(const std::vector<std::uint8_t>& data, const std::size_t offset) {
    return (std::uint32_t(data[offset]) << 24) | (std::uint32_t(data[offset + 1]) << 16) |
           (std::uint32_t(data[offset + 2]) << 8) | std::uint32_t(data[offset + 3]);
}
std::uint16_t read_u16(const std::vector<std::uint8_t>& data, const std::size_t offset) {
    return static_cast<std::uint16_t>(
        (std::uint16_t(data[offset]) << 8) | std::uint16_t(data[offset + 1]));
}
std::uint64_t read_u64(const std::vector<std::uint8_t>& data, const std::size_t offset) {
    return (std::uint64_t(read_u32(data, offset)) << 32) | std::uint64_t(read_u32(data, offset + 4));
}
std::int32_t read_i32(const std::vector<std::uint8_t>& data, const std::size_t offset) {
    return static_cast<std::int32_t>(read_u32(data, offset));
}

struct BoxRange { std::size_t payload_start, payload_end; };

std::optional<BoxRange> find_box(const std::vector<std::uint8_t>& data, const std::size_t start,
                                  const std::size_t end, const char* type) {
    std::size_t offset = start;
    while (offset + 8 <= end) {
        const auto box_size = read_u32(data, offset);
        if (box_size < 8 || offset + box_size > end) break;
        if (std::equal(type, type + 4, data.begin() + static_cast<std::ptrdiff_t>(offset) + 4)) {
            return BoxRange{offset + 8, offset + box_size};
        }
        offset += box_size;
    }
    return std::nullopt;
}

struct ParsedSample {
    std::uint32_t duration = 0;
    std::int32_t composition_offset = 0;
};

struct ParsedSegment {
    std::uint64_t tfdt = 0;
    std::uint32_t sequence = 0;
    std::uint32_t track_id = 0;
    std::vector<ParsedSample> samples;
};

ParsedSegment parse_segment(const std::vector<std::uint8_t>& data) {
    const auto moof = find_box(data, 0, data.size(), "moof");
    check(moof.has_value(), "segment is missing a moof box");
    const auto traf = find_box(data, moof->payload_start, moof->payload_end, "traf");
    check(traf.has_value(), "moof is missing a traf box");
    const auto mfhd = find_box(data, moof->payload_start, moof->payload_end, "mfhd");
    check(mfhd.has_value(), "moof is missing an mfhd box");
    const auto tfhd = find_box(data, traf->payload_start, traf->payload_end, "tfhd");
    check(tfhd.has_value(), "traf is missing a tfhd box");
    const auto tfdt = find_box(data, traf->payload_start, traf->payload_end, "tfdt");
    check(tfdt.has_value(), "traf is missing a tfdt box");
    check(data[tfdt->payload_start] == 1, "tfdt must be version 1 (64-bit baseMediaDecodeTime)");
    const auto trun = find_box(data, traf->payload_start, traf->payload_end, "trun");
    check(trun.has_value(), "traf is missing a trun box");
    check(data[trun->payload_start] == 1, "trun must be version 1");
    const auto flags = (std::uint32_t(data[trun->payload_start + 1]) << 16) |
                        (std::uint32_t(data[trun->payload_start + 2]) << 8) |
                        std::uint32_t(data[trun->payload_start + 3]);
    check(flags == 0x000f01, "trun must carry duration/size/flags/composition-offset for every sample");

    ParsedSegment result;
    result.sequence = read_u32(data, mfhd->payload_start + 4);
    result.track_id = read_u32(data, tfhd->payload_start + 4);
    result.tfdt = read_u64(data, tfdt->payload_start + 4);
    const auto sample_count = read_u32(data, trun->payload_start + 4);
    const auto entries_start = trun->payload_start + 12;
    for (std::uint32_t index = 0; index < sample_count; ++index) {
        const auto base = entries_start + std::size_t(index) * 16;
        ParsedSample sample;
        sample.duration = read_u32(data, base);
        sample.composition_offset = read_i32(data, base + 12);
        result.samples.push_back(sample);
    }
    return result;
}

std::size_t direct_box_count(const std::vector<std::uint8_t>& data,
                             const std::size_t start, const std::size_t end,
                             const char* type) {
    std::size_t count = 0;
    std::size_t offset = start;
    while (offset + 8 <= end) {
        const auto box_size = read_u32(data, offset);
        if (box_size < 8 || offset + box_size > end) break;
        if (std::equal(type, type + 4,
                       data.begin() + static_cast<std::ptrdiff_t>(offset) + 4)) {
            ++count;
        }
        offset += box_size;
    }
    return count;
}

std::uint32_t mdhd_timescale(const std::vector<std::uint8_t>& init_segment) {
    const auto moov = find_box(init_segment, 0, init_segment.size(), "moov");
    check(moov.has_value(), "init segment is missing a moov box");
    const auto trak = find_box(init_segment, moov->payload_start, moov->payload_end, "trak");
    check(trak.has_value(), "moov is missing a trak box");
    const auto mdia = find_box(init_segment, trak->payload_start, trak->payload_end, "mdia");
    check(mdia.has_value(), "trak is missing a mdia box");
    const auto mdhd = find_box(init_segment, mdia->payload_start, mdia->payload_end, "mdhd");
    check(mdhd.has_value(), "mdia is missing a mdhd box");
    return read_u32(init_segment, mdhd->payload_start + 12);  // version/flags(4) + creation/modification time(8)
}

struct ParsedColorInformation {
    std::uint16_t primaries = 0;
    std::uint16_t transfer = 0;
    std::uint16_t matrix = 0;
    bool full_range = false;
    bool operator==(const ParsedColorInformation&) const = default;
};

ParsedColorInformation video_color_information(
    const std::vector<std::uint8_t>& init_segment) {
    const auto moov = find_box(init_segment, 0, init_segment.size(), "moov");
    check(moov.has_value(), "init segment is missing a moov box");
    const auto trak = find_box(init_segment, moov->payload_start, moov->payload_end, "trak");
    check(trak.has_value(), "moov is missing a trak box");
    const auto mdia = find_box(init_segment, trak->payload_start, trak->payload_end, "mdia");
    check(mdia.has_value(), "trak is missing a mdia box");
    const auto minf = find_box(init_segment, mdia->payload_start, mdia->payload_end, "minf");
    check(minf.has_value(), "mdia is missing a minf box");
    const auto stbl = find_box(init_segment, minf->payload_start, minf->payload_end, "stbl");
    check(stbl.has_value(), "minf is missing a stbl box");
    const auto stsd = find_box(init_segment, stbl->payload_start, stbl->payload_end, "stsd");
    check(stsd.has_value(), "stbl is missing a stsd box");
    const auto hvc1 = find_box(init_segment, stsd->payload_start + 8, stsd->payload_end, "hvc1");
    check(hvc1.has_value(), "stsd is missing an hvc1 sample entry");
    const auto colr = find_box(init_segment, hvc1->payload_start + 78,
                               hvc1->payload_end, "colr");
    check(colr.has_value() && colr->payload_end - colr->payload_start == 11,
          "hvc1 is missing a valid colr box");
    check(std::equal(init_segment.begin() + static_cast<std::ptrdiff_t>(colr->payload_start),
                     init_segment.begin() + static_cast<std::ptrdiff_t>(colr->payload_start + 4),
                     "nclx"),
          "colr does not use the nclx colour type");
    return {
        read_u16(init_segment, colr->payload_start + 4),
        read_u16(init_segment, colr->payload_start + 6),
        read_u16(init_segment, colr->payload_start + 8),
        (init_segment[colr->payload_start + 10] & 0x80U) != 0,
    };
}

std::vector<ParsedSegment> segments_of(const std::vector<tlvdemux::MseMediaSegment>& segments,
                                       const std::string& type) {
    std::vector<ParsedSegment> out;
    for (const auto& segment : segments) if (segment.type == type) out.push_back(parse_segment(segment.data));
    return out;
}

// Reconstructs each sample's composition timestamp (tfdt + running dts sum +
// composition_offset) across a run of segments, in emission order.
std::vector<std::int64_t> composition_timestamps(const std::vector<ParsedSegment>& segments) {
    std::vector<std::int64_t> out;
    for (const auto& segment : segments) {
        std::int64_t dts = std::int64_t(segment.tfdt);
        for (const auto& sample : segment.samples) {
            out.push_back(dts + sample.composition_offset);
            dts += std::int64_t(sample.duration);
        }
    }
    return out;
}

// ---- HEVC Annex B synthesis: only what parse_sps() in mse_remuxer.cpp
// actually reads, plus the NAL headers/types the muxer inspects. ----

void write_ue(BitWriter& writer, const std::uint32_t value) {
    const auto code_num = value + 1;
    unsigned leading_zeros = 0;
    while ((code_num >> leading_zeros) > 1) ++leading_zeros;
    for (unsigned i = 0; i < leading_zeros; ++i) writer.bits(0, 1);
    writer.bits(code_num, leading_zeros + 1);
}

std::uint16_t nal_header(const unsigned type) {
    return static_cast<std::uint16_t>((type & 0x3fU) << 9 | 1U);  // layer_id 0, temporal_id_plus1 1
}
std::vector<std::uint8_t> nal_header_bytes(const unsigned type) {
    const auto value = nal_header(type);
    return {static_cast<std::uint8_t>(value >> 8), static_cast<std::uint8_t>(value)};
}
std::vector<std::uint8_t> make_simple_nal(const unsigned type, const std::vector<std::uint8_t>& payload) {
    auto out = nal_header_bytes(type);
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

// Inverse of mse_remuxer.cpp's rbsp() de-escaper: inserts emulation_prevention_three_byte
// so the raw bit content survives the muxer's Annex B parsing unchanged.
std::vector<std::uint8_t> escape_rbsp(const std::vector<std::uint8_t>& raw) {
    std::vector<std::uint8_t> out;
    unsigned zero_run = 0;
    for (const auto byte : raw) {
        if (zero_run >= 2 && byte <= 3) { out.push_back(3); zero_run = 0; }
        out.push_back(byte);
        zero_run = byte == 0 ? zero_run + 1 : 0;
    }
    return out;
}

// Matches the fields parse_sps() reads, with
// sps_max_sub_layers_minus1 = 0 so its sub-layer loops are skipped.
std::vector<std::uint8_t> build_sps_nalu(const std::uint32_t width, const std::uint32_t height,
                                         const std::uint8_t transfer = 18) {
    BitWriter writer;
    writer.bits(nal_header(33), 16);
    writer.bits(0, 4);  // sps_video_parameter_set_id
    writer.bits(0, 3);  // sps_max_sub_layers_minus1
    writer.bits(1, 1);  // sps_temporal_id_nesting_flag
    writer.bits(0, 2);  // profile_space
    writer.bits(0, 1);  // tier
    writer.bits(1, 5);  // profile_idc
    for (int i = 0; i < 4; ++i) writer.bits(0, 8);  // general_profile_compatibility_flag[32]
    for (int i = 0; i < 6; ++i) writer.bits(0, 8);  // general_constraint flags[48]
    writer.bits(93, 8);  // level_idc
    write_ue(writer, 0);       // sps_seq_parameter_set_id
    write_ue(writer, 1);       // chroma_format_idc (4:2:0)
    write_ue(writer, width);   // pic_width_in_luma_samples
    write_ue(writer, height);  // pic_height_in_luma_samples
    writer.bits(0, 1);  // conformance_window_flag
    write_ue(writer, 0);  // bit_depth_luma_minus8
    write_ue(writer, 0);  // bit_depth_chroma_minus8
    write_ue(writer, 4);  // log2_max_pic_order_cnt_lsb_minus4
    writer.bits(0, 1);    // sps_sub_layer_ordering_info_present_flag
    write_ue(writer, 0);  // sps_max_dec_pic_buffering_minus1[0]
    write_ue(writer, 0);  // sps_max_num_reorder_pics[0]
    write_ue(writer, 0);  // sps_max_latency_increase_plus1[0]
    for (int i = 0; i < 6; ++i) write_ue(writer, 0);  // coding/transform block sizes
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
    writer.bits(1, 8);  // square pixels
    writer.bits(0, 1);  // overscan_info_present_flag
    writer.bits(1, 1);  // video_signal_type_present_flag
    writer.bits(0, 3);  // component video
    writer.bits(0, 1);  // video_full_range_flag: limited range
    writer.bits(1, 1);  // colour_description_present_flag
    writer.bits(9, 8);  // BT.2020 primaries
    writer.bits(transfer, 8);
    writer.bits(9, 8);  // BT.2020 non-constant matrix
    return escape_rbsp(writer.take());
}

std::vector<std::uint8_t> annex_b_wrap(const std::vector<std::uint8_t>& nalu) {
    std::vector<std::uint8_t> out{0, 0, 0, 1};
    out.insert(out.end(), nalu.begin(), nalu.end());
    return out;
}

// vcl_types gives one VCL NAL per entry (so a test can drive RASL/RADL/BLA/CRA
// mixes directly); trailing_nal optionally appends a non-VCL NAL such as
// EOS_NUT after them, and an empty vcl_types with a trailing_nal builds an
// access unit that carries only that marker NAL.
std::vector<std::uint8_t> video_access_unit_data(const bool include_parameter_sets,
                                                  const std::vector<unsigned>& vcl_types,
                                                  const std::optional<unsigned> trailing_nal = std::nullopt,
                                                  const std::uint8_t transfer = 18) {
    std::vector<std::uint8_t> out;
    if (include_parameter_sets) {
        for (const auto& nalu : {annex_b_wrap(make_simple_nal(32, {0xab, 0xcd})),   // VPS
                                 annex_b_wrap(make_simple_nal(34, {0xab, 0xcd})),   // PPS
                                 annex_b_wrap(build_sps_nalu(1920, 1080, transfer))}) { // SPS
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

std::vector<std::uint8_t> video_access_unit_data(const bool include_parameter_sets, const bool keyframe) {
    return video_access_unit_data(include_parameter_sets, std::vector<unsigned>{keyframe ? 19u : 1u});  // IDR_W_RADL / TRAIL_R
}

tlvdemux::AccessUnit hevc_unit(const std::uint64_t track_id, const std::int64_t dts_value,
                               const std::int64_t pts_value, const bool keyframe,
                               const bool include_parameter_sets,
                               const std::uint32_t timescale = 1000000) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_access_unit_data(include_parameter_sets, keyframe);
    unit.dts = {dts_value, timescale};
    unit.pts = {pts_value, timescale};
    unit.random_access = keyframe;
    return unit;
}

tlvdemux::AccessUnit hevc_unit_with_transfer(const std::uint64_t track_id,
                                             const std::int64_t dts_value,
                                             const std::int64_t pts_value,
                                             const bool keyframe,
                                             const bool include_parameter_sets,
                                             const std::uint8_t transfer,
                                             const std::uint32_t timescale = 1000000) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_access_unit_data(include_parameter_sets,
                                       std::vector<unsigned>{keyframe ? 19u : 1u},
                                       std::nullopt, transfer);
    unit.dts = {dts_value, timescale};
    unit.pts = {pts_value, timescale};
    unit.random_access = keyframe;
    return unit;
}

tlvdemux::AccessUnit hevc_unit(const std::uint64_t track_id, const std::int64_t dts_value,
                               const std::int64_t pts_value, const std::vector<unsigned>& vcl_types,
                               const bool include_parameter_sets,
                               const std::optional<unsigned> trailing_nal = std::nullopt,
                               const std::uint32_t timescale = 1000000) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::Hevc;
    unit.data = video_access_unit_data(include_parameter_sets, vcl_types, trailing_nal);
    unit.dts = {dts_value, timescale};
    unit.pts = {pts_value, timescale};
    unit.random_access = std::any_of(vcl_types.begin(), vcl_types.end(),
                                      [](const unsigned type) { return type >= 16 && type <= 21; });
    return unit;
}

void test_audio_drops_non_advancing_dts() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    // Audio only starts emitting once the video track has started (it supplies
    // the shared timeline offset), so prime it with a single keyframe.
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    // 48000 is the AAC track's timescale here, and audio uses pts == dts, so a
    // pts.timescale of 48000 makes the muxer's internal microsecond round trip
    // exact (48000 * (1e6/48000) * (48000/1e6) == 48000) whenever the value is
    // a multiple of 6 -- no floating point slack to account for below.
    const std::int64_t step = 600;
    std::vector<std::int64_t> pts_values;
    for (int i = 0; i <= 10; ++i) pts_values.push_back(step * i);
    pts_values.push_back(step * 10);        // exact repeat: must be dropped
    pts_values.push_back(step * 10 - 300);  // goes backwards: must be dropped
    for (int i = 11; i < 40; ++i) pts_values.push_back(step * i);

    for (const auto value : pts_values) {
        auto unit = audio_unit(2);
        unit.pts = {value, 48000};
        unit.dts = unit.pts;
        remuxer.push(unit);
    }
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "audio");
    check(segments.size() >= 2, "audio push should have spanned multiple fragments");

    std::int64_t expected_dts = 0;
    std::size_t total_samples = 0;
    for (std::size_t s = 0; s < segments.size(); ++s) {
        const auto& segment = segments[s];
        check(std::int64_t(segment.tfdt) == expected_dts,
              "audio fragment tfdt does not continue the previous fragment's decode timeline");
        std::uint64_t sum_durations = 0;
        for (const auto& sample : segment.samples) {
            check(sample.duration == std::uint32_t(step),
                  "a sample duration was fabricated instead of dropping the non-advancing input");
            sum_durations += sample.duration;
            ++total_samples;
        }
        expected_dts += std::int64_t(sum_durations);
    }
    check(total_samples == 40,
          "the two non-advancing samples were papered over with a fallback duration instead of dropped");
}

struct ReorderedFrame { std::int64_t dts, pts; bool keyframe; };

std::vector<ReorderedFrame> build_reordered_frames(const int groups, const std::int64_t dts_step) {
    std::vector<ReorderedFrame> frames{{0, 0, true}};
    for (int g = 0; g < groups; ++g) {
        const auto base = dts_step * (3 * g + 1);
        frames.push_back({base, base + 2 * dts_step, false});
        frames.push_back({base + dts_step, base, false});
        frames.push_back({base + 2 * dts_step, base + dts_step, false});
    }
    return frames;
}

void test_video_fragments_do_not_overlap_in_composition_time() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    const auto frames = build_reordered_frames(10, 100000);
    bool first = true;
    for (const auto& frame : frames) {
        remuxer.push(hevc_unit(2, frame.dts, frame.pts, frame.keyframe, first));
        first = false;
    }
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() >= 2, "reordered video push should have spanned multiple fragments");

    std::vector<std::pair<std::int64_t, std::int64_t>> intervals;
    for (const auto& segment : segments) {
        std::int64_t dts = std::int64_t(segment.tfdt);
        auto min_pts = std::numeric_limits<std::int64_t>::max();
        auto max_end = std::numeric_limits<std::int64_t>::min();
        for (const auto& sample : segment.samples) {
            const auto pts = dts + sample.composition_offset;
            min_pts = std::min(min_pts, pts);
            max_end = std::max(max_end, pts + std::int64_t(sample.duration));
            dts += std::int64_t(sample.duration);
        }
        intervals.emplace_back(min_pts, max_end);
    }
    for (std::size_t i = 0; i + 1 < intervals.size(); ++i) {
        check(intervals[i].second <= intervals[i + 1].first,
              "fragment " + std::to_string(i) +
                  " composition interval overlaps the next fragment's, which Firefox's "
                  "CtsComparator would misinterpret as evicting already-buffered frames");
    }
}

// Real broadcast video (see demo/bsp4k-lag-3.mmts) runs at timescale 180000
// with a 3003-tick frame interval -- 16683.33us, which does not divide the
// MP4 track timescale evenly. Pins the fix that makes the video track adopt
// unit.dts.timescale instead of hardcoding 1000000, so samples never round
// through an inexact microsecond conversion.
void test_video_fragments_do_not_overlap_with_broadcast_timescale() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::uint32_t broadcast_timescale = 180000;
    constexpr std::int64_t frame_ticks = 3003;

    const auto frames = build_reordered_frames(80, frame_ticks);
    bool first = true;
    for (const auto& frame : frames) {
        remuxer.push(hevc_unit(2, frame.dts, frame.pts, frame.keyframe, first, broadcast_timescale));
        first = false;
    }
    remuxer.flush();

    check(sink.inits.size() == 1, "video push should have produced exactly one init segment");
    check(mdhd_timescale(sink.inits.front().data) == broadcast_timescale,
          "mdhd timescale must track the stream's own timescale, not a hardcoded default");

    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() >= 2, "reordered video push should have spanned multiple fragments");

    std::vector<std::pair<std::int64_t, std::int64_t>> intervals;
    for (const auto& segment : segments) {
        std::int64_t dts = std::int64_t(segment.tfdt);
        auto min_pts = std::numeric_limits<std::int64_t>::max();
        auto max_end = std::numeric_limits<std::int64_t>::min();
        for (const auto& sample : segment.samples) {
            const auto pts = dts + sample.composition_offset;
            min_pts = std::min(min_pts, pts);
            max_end = std::max(max_end, pts + std::int64_t(sample.duration));
            dts += std::int64_t(sample.duration);
        }
        intervals.emplace_back(min_pts, max_end);
    }
    for (std::size_t i = 0; i + 1 < intervals.size(); ++i) {
        check(intervals[i].second <= intervals[i + 1].first,
              "fragment " + std::to_string(i) +
                  " composition interval overlaps the next fragment's under a broadcast "
                  "timescale, which Firefox's CtsComparator would misinterpret as evicting "
                  "already-buffered frames");
    }
}

// A track with a fixed, monotonically increasing DTS step but a monotonically
// DECREASING PTS never offers safe_prefix() a cut point. Every ready sample's
// duration is the constant DTS step, so its composition end is pts_0 + step --
// the maximum over the whole run, since pts only falls after that. Meanwhile
// the most recently queued sample (pending_, or the tail of ready_) always
// holds the minimum PTS of everything still queued past any candidate cut.
// So the cut test `prefix_end <= min_from[cut]` reduces to `pts_0 + step <=
// pts_of_latest_sample`, which is false as soon as more than one sample has
// been pushed (pts_of_latest_sample < pts_0 by then). Only BaseMuxer::enqueue's
// unconditional queue-duration bound can ever emit for such a stream.
void test_video_queue_bound_forces_emit_without_safe_cut() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    // Video track timescale defaults to 1000000, so the periodic-emit
    // threshold is 1000000 / kFragmentDurationDivisor(4) = 250000us and the
    // forced queue-duration bound is 8x that = 2000000us.
    constexpr std::int64_t dts_step = 70000;
    constexpr std::int64_t pts_step = 70000;
    constexpr std::int64_t initial_pts = 3000000;
    constexpr int sample_count = 35;

    for (int i = 0; i < sample_count; ++i) {
        const auto dts = dts_step * i;
        const auto pts = initial_pts - pts_step * i;
        check(pts >= 0, "test setup: PTS must stay non-negative for the whole run");
        remuxer.push(hevc_unit(2, dts, pts, i == 0, i == 0));
    }

    // Captured before flush(): if the bound never fired, nothing would have
    // been emitted yet and this would be empty.
    const auto segments_before_flush = segments_of(sink.segments, "video");
    check(!segments_before_flush.empty(),
          "a stream with no safe composition cut point must still be bounded by "
          "the forced queue-duration emit, not accumulate everything until flush()");

    constexpr std::uint64_t bound_us = 2000000;
    std::uint64_t first_segment_duration = 0;
    for (const auto& sample : segments_before_flush.front().samples) {
        first_segment_duration += sample.duration;
    }
    check(first_segment_duration >= bound_us,
          "the forced emit fired before the queue reached its duration bound");
    check(first_segment_duration < bound_us + std::uint64_t(dts_step),
          "the queue grew past its duration bound by more than a single sample");

    remuxer.flush();
}

// ITU-T H.265 8.1.3 / RFC 7798 1.1.4: NoRaslOutputFlag is 1 for a mid-stream
// BLA regardless of what came before it, so its RASL cannot be decoded.
void test_mid_stream_bla_drops_rasl() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit(2, 0, 0, std::vector<unsigned>{21}, true));              // CRA opens the sequence
    remuxer.push(hevc_unit(2, step, step, std::vector<unsigned>{1}, false));        // trailing picture closes the initial window
    remuxer.push(hevc_unit(2, 2 * step, 2 * step, std::vector<unsigned>{1}, false));
    remuxer.push(hevc_unit(2, 3 * step, 3 * step, std::vector<unsigned>{17}, false));  // mid-stream BLA
    remuxer.push(hevc_unit(2, 4 * step, 4 * step, std::vector<unsigned>{9}, false));   // its RASL: must be dropped
    remuxer.push(hevc_unit(2, 5 * step, 5 * step, std::vector<unsigned>{1}, false));   // first trailing picture closes the window
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    const std::vector<std::int64_t> expected{0, step, 2 * step, 3 * step, 5 * step};
    check(composition_timestamps(segments) == expected,
          "a mid-stream BLA's RASL access unit was not dropped");
}

// A CRA only gets NoRaslOutputFlag=1 when it opens a fresh coded video
// sequence, which an EOS/EOB NAL in a preceding access unit also triggers.
void test_cra_after_eos_drops_rasl() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit(2, 0, 0, std::vector<unsigned>{21}, true));              // CRA opens the sequence
    remuxer.push(hevc_unit(2, step, step, std::vector<unsigned>{1}, false));        // trailing picture closes the initial window
    remuxer.push(hevc_unit(2, 2 * step, 2 * step, std::vector<unsigned>{1}, false));
    remuxer.push(hevc_unit(2, 3 * step, 3 * step, std::vector<unsigned>{}, false, 36u));  // EOS_NUT-only access unit
    remuxer.push(hevc_unit(2, 4 * step, 4 * step, std::vector<unsigned>{21}, false));     // CRA following the EOS
    remuxer.push(hevc_unit(2, 5 * step, 5 * step, std::vector<unsigned>{9}, false));      // its RASL: must be dropped
    remuxer.push(hevc_unit(2, 6 * step, 6 * step, std::vector<unsigned>{1}, false));      // first trailing picture closes the window
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    const std::vector<std::int64_t> expected{0, step, 2 * step, 4 * step, 6 * step};
    check(composition_timestamps(segments) == expected,
          "a CRA that follows an end-of-sequence NAL did not drop its RASL");
}

// A plain mid-stream CRA -- not the first access unit and not preceded by an
// EOS/EOB -- never gets NoRaslOutputFlag=1, so its RASL is decodable and must
// reach the sample stream. Regression guard against over-dropping.
void test_plain_mid_stream_cra_keeps_rasl() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit(2, 0, 0, std::vector<unsigned>{21}, true));              // CRA opens the sequence
    remuxer.push(hevc_unit(2, step, step, std::vector<unsigned>{1}, false));        // trailing picture closes the initial window
    remuxer.push(hevc_unit(2, 2 * step, 2 * step, std::vector<unsigned>{1}, false));
    remuxer.push(hevc_unit(2, 3 * step, 3 * step, std::vector<unsigned>{21}, false));  // plain mid-stream CRA
    remuxer.push(hevc_unit(2, 4 * step, 4 * step, std::vector<unsigned>{9}, false));   // its RASL: must survive
    remuxer.push(hevc_unit(2, 5 * step, 5 * step, std::vector<unsigned>{1}, false));
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    const std::vector<std::int64_t> expected{0, step, 2 * step, 3 * step, 4 * step, 5 * step};
    check(composition_timestamps(segments) == expected,
          "a plain mid-stream CRA's RASL was dropped even though NoRaslOutputFlag was never armed for it");
}

// RASL must precede RADL in presentation order but not necessarily in
// decoding order, so a RADL of the same IRAP can arrive first. It is leading
// and decodable, so it must not end the drop window the IRAP armed.
void test_radl_does_not_reopen_gate() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit(2, 0, 0, std::vector<unsigned>{21}, true));               // CRA opens the sequence, arms the latch
    remuxer.push(hevc_unit(2, step, step, std::vector<unsigned>{6}, false));         // RADL: leading, must not reopen the gate
    remuxer.push(hevc_unit(2, 2 * step, 2 * step, std::vector<unsigned>{9}, false)); // RASL: still dropped
    remuxer.push(hevc_unit(2, 3 * step, 3 * step, std::vector<unsigned>{1}, false)); // first trailing picture closes the window
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    const std::vector<std::int64_t> expected{0, step, 3 * step};
    check(composition_timestamps(segments) == expected,
          "a RADL access unit reopened the RASL drop window before the first trailing picture");
}

std::int64_t audio_time_us(const std::int64_t ticks) {
    return (ticks * 1000000 + 24000) / 48000;
}

void test_audio_switch_uses_cached_frame_boundary_without_video_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 10);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(10, 0, 0, true, true));
    check(!remuxer.switchAudioTrack(99, 0).has_value() && sink.splices.empty(),
          "an unavailable target changed the active audio timeline");

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 30; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        remuxer.push(audio_unit(2, index * frame));
    }
    const auto segment_count_before = sink.segments.size();
    const auto first_boundary = remuxer.switchAudioTrack(
        2, audio_time_us(8 * frame));
    check(first_boundary == audio_time_us(8 * frame),
          "audio switch did not choose the first cached AAC frame at the requested boundary");
    check(sink.splices.size() == 1 &&
              sink.splices.front().presentation_time_us == *first_boundary,
          "audio switch did not announce the SourceBuffer replacement boundary");
    check(sink.segments.size() > segment_count_before,
          "prepared target audio was not emitted during the switch");
    const auto first_target = parse_segment(sink.segments[segment_count_before].data);
    check(first_target.tfdt == std::uint64_t(8 * frame),
          "target audio did not retain its broadcast timeline at the splice");
    check(sink.segments[segment_count_before].start_time_us == *first_boundary,
          "audio media metadata does not match the fragment tfdt");
    const auto splice_event = std::find(sink.events.begin(), sink.events.end(), "splice");
    check(splice_event != sink.events.end() &&
              std::next(splice_event) != sink.events.end() &&
              *std::next(splice_event) == "init:audio",
          "audio splice must be delivered before the replacement init segment");

    for (std::int64_t index = 30; index < 40; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        remuxer.push(audio_unit(2, index * frame));
    }
    const auto second_segment_count = sink.segments.size();
    const auto second_boundary = remuxer.switchAudioTrack(
        1, audio_time_us(32 * frame));
    check(second_boundary == audio_time_us(32 * frame),
          "switching back reused stale resume state instead of cached timestamps");
    check(sink.segments.size() > second_segment_count,
          "switching back did not emit cached audio");
    check(parse_segment(sink.segments[second_segment_count].data).tfdt ==
              std::uint64_t(32 * frame),
          "switching back did not begin at the requested AAC frame");
}

void test_video_track_switch_preserves_prepared_alternate_audio() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 12; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    auto damaged_selected_video = hevc_unit(2, 50000, 50000, false, false);
    damaged_selected_video.discontinuity = true;
    remuxer.push(damaged_selected_video);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 3);
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    replacement.discontinuity = true;
    remuxer.push(replacement);

    const auto requested_boundary = audio_time_us(6 * frame);
    const auto boundary = remuxer.switchAudioTrack(9, requested_boundary);
    check(boundary == requested_boundary,
          "video-layer discontinuity cleared prepared alternate-audio history");
    check(sink.splices.size() == 1 &&
              sink.splices.front().presentation_time_us == requested_boundary,
          "alternate-audio switch did not retain its cached boundary after video-layer switch");
}

void test_layer_switch_coordinates_video_rap_and_prepared_audio() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 24; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        auto alternate = audio_unit(9, index * frame);
        alternate.discontinuity = index == 12;
        remuxer.push(alternate);
    }
    check(remuxer.switchLayer(3, 9, audio_time_us(4 * frame)),
          "valid layer switch request was rejected");
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    remuxer.push(replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    const auto expected_audio_boundary = audio_time_us(5 * frame);
    check(sink.layer_switches.size() == 1,
          "prepared A/V layer switch did not emit completion");
    const auto& completed = sink.layer_switches.front();
    check(completed.video_track_id == 3 && completed.audio_track_id == 9 &&
              completed.video_presentation_time_us == 100000 &&
              completed.audio_presentation_time_us == expected_audio_boundary,
          "layer-switch completion did not expose its actual A/V boundaries");
    check(sink.video_splices.size() == 1 && sink.splices.size() == 1 &&
              sink.splices.front().presentation_time_us == expected_audio_boundary,
          "layer switch did not splice both SourceBuffers");
    const auto video_splice = std::find(
        sink.events.begin(), sink.events.end(), "video-splice");
    const auto audio_splice = std::find(sink.events.begin(), sink.events.end(), "splice");
    const auto replacement_video_segment = std::find(
        video_splice, sink.events.end(), "segment:video");
    const auto completion = std::find(
        sink.events.begin(), sink.events.end(), "layer-switch");
    check(video_splice < replacement_video_segment &&
              replacement_video_segment < audio_splice && audio_splice < completion,
          "layer switch did not release staged video before prepared audio and completion");
    check(!remuxer.endOfStream().has_value() &&
              sink.layer_switch_cancellations.empty(),
          "completed layer switch was later reported as cancelled");
}

void test_layer_switch_replays_cached_target_video_from_requested_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    remuxer.push(hevc_unit(
        3, 800000, 800000, std::vector<unsigned>{}, true));
    remuxer.push(hevc_unit(3, 850000, 850000, true, false));
    remuxer.push(hevc_unit(
        3, 1000000, 1000000, std::vector<unsigned>{21}, false));
    remuxer.push(hevc_unit(3, 1033367, 1033367, false, false));
    remuxer.push(hevc_unit(
        3, 1200000, 1200000, std::vector<unsigned>{19}, false));
    remuxer.push(hevc_unit(3, 1233367, 1233367, false, false));
    for (std::int64_t index = 2; index <= 20; ++index) {
        const auto timestamp = 1200000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 47; index < 90; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    const auto segment_count = sink.segments.size();
    check(remuxer.switchLayer(3, 9, 900000),
          "cached layer switch request was rejected");

    check(sink.layer_switches.size() == 1,
          "cached target video was not replayed synchronously");
    check(sink.layer_switches.front().video_presentation_time_us == 1200000,
          "cached switch did not prefer a nearby closed IRAP over CRA");
    const auto expected_audio_boundary = audio_time_us(57 * frame);
    check(sink.layer_switches.front().audio_presentation_time_us == expected_audio_boundary,
          "cached video replay did not align prepared target audio");
    check(std::any_of(sink.segments.begin(), sink.segments.end(),
              [expected_audio_boundary](const tlvdemux::MseMediaSegment& segment) {
                  return segment.type == "audio" &&
                      segment.start_time_us == expected_audio_boundary;
              }),
          "cached layer switch did not preserve replacement audio time");
    check(sink.segments.size() > segment_count,
          "cached video replay did not emit replacement media");
}

void test_layer_switch_waits_for_target_audio_after_video_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));

    check(remuxer.switchLayer(3, 9, 0),
          "layer switch should accept an audio track that has not arrived yet");
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    replacement.discontinuity = true;
    remuxer.push(replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }
    check(sink.layer_switches.empty(),
          "layer switch completed before target audio reached the video boundary");

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index <= 22; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    check(sink.video_splices.empty() && sink.layer_switches.empty(),
          "layer switch exposed target video before audio had 400ms prepared");
    remuxer.push(audio_unit(9, 23 * frame));
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().audio_presentation_time_us ==
                  audio_time_us(5 * frame),
          "layer switch did not complete after target audio had 400ms prepared");
}

void test_layer_switch_retries_distant_audio_at_later_video_boundary() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));

    check(remuxer.switchLayer(3, 9, 0),
          "timestamp retry test could not request a layer switch");
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    replacement.discontinuity = true;
    remuxer.push(replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    constexpr std::int64_t frame = 1024;
    constexpr std::int64_t distant_start = 5 * 48000;
    for (std::int64_t index = 0; index < 24; ++index) {
        remuxer.push(audio_unit(9, distant_start + index * frame));
    }

    check(sink.layer_switches.empty() && sink.video_splices.empty() &&
              sink.splices.empty() && sink.layer_switch_cancellations.empty(),
          "distant audio boundary was committed or cancelled before a later RAP");

    auto aligned_replacement = hevc_unit(3, 5100000, 5100000, true, false);
    aligned_replacement.discontinuity = true;
    remuxer.push(aligned_replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 5100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }
    const auto expected_audio_boundary =
        5000000 + audio_time_us(5 * frame);
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().video_presentation_time_us == 5100000 &&
              sink.layer_switches.front().audio_presentation_time_us ==
                  expected_audio_boundary,
          "layer switch did not retry at an A/V-aligned video RAP");
}

void test_layer_switch_uses_first_replacement_presentation_time() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));

    check(remuxer.switchLayer(3, 1, 0),
          "same-audio layer switch request was rejected");
    remuxer.push(hevc_unit(3, 100000, 133367, std::vector<unsigned>{19}, true));
    remuxer.push(hevc_unit(3, 133367, 100000, std::vector<unsigned>{6}, false));
    for (std::int64_t index = 2; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    check(sink.layer_switches.size() == 1 && sink.video_splices.size() == 1,
          "reordered replacement video did not complete its layer switch");
    check(sink.video_splices.front().presentation_time_us == 100000 &&
              sink.layer_switches.front().video_presentation_time_us == 100000,
          "video splice did not move back to the first replacement presentation time");
    check(sink.splices.empty(),
          "video-only layer switch unnecessarily replaced the working audio buffer");
}

void test_unspecified_media_timescale_is_not_remuxed() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));

    auto invalid_video = hevc_unit(2, 84181, 90187, false, false, 1);
    auto invalid_audio = audio_unit(1, 7776);
    invalid_audio.pts.timescale = 1;
    invalid_audio.dts.timescale = 1;
    remuxer.push(invalid_video);
    remuxer.push(invalid_audio);
    remuxer.flush();

    check(std::all_of(sink.segments.begin(), sink.segments.end(),
              [](const tlvdemux::MseMediaSegment& segment) {
                  return segment.start_time_us < 1000000 && segment.end_time_us < 1000000;
              }),
          "timescale-1 media access unit expanded an MSE segment");
}

void test_layer_switch_cancels_once_at_end_of_input() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    check(remuxer.switchLayer(3, 9, 0),
          "layer switch used by end-of-input test was rejected");
    const auto cancelled = remuxer.endOfStream();
    check(cancelled.has_value() &&
              cancelled->reason == tlvdemux::MseLayerSwitchCancelReason::EndOfInput &&
              cancelled->video_track_id == 3 && cancelled->audio_track_id == 9 &&
              cancelled->previous_video_track_id == 2 &&
              cancelled->previous_audio_track_id == 1,
          "end of input did not return the complete cancelled selection");
    check(sink.layer_switch_cancellations.size() == 1 &&
              !remuxer.endOfStream().has_value() &&
              sink.layer_switch_cancellations.size() == 1,
          "end of input emitted duplicate layer-switch cancellation");
}

void test_layer_switch_cancels_on_reposition_and_explicit_selection() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    check(remuxer.switchLayer(3, 9, 0),
          "layer switch used by reposition test was rejected");
    const auto repositioned = remuxer.reposition();
    check(repositioned.has_value() &&
              repositioned->reason == tlvdemux::MseLayerSwitchCancelReason::Reposition,
          "reposition did not cancel its pending layer switch");

    check(remuxer.switchLayer(3, 9, 0),
          "restored old selection could not start another layer switch");
    const auto selected = remuxer.selectTrack(tlvdemux::TrackKind::Video, 4);
    check(selected.has_value() &&
              selected->reason == tlvdemux::MseLayerSwitchCancelReason::SelectionChanged &&
              sink.layer_switch_cancellations.size() == 2,
          "explicit track selection did not cancel the pending layer switch");

    TestSink reset_sink;
    tlvdemux::MseRemuxer reset_remuxer(reset_sink);
    reset_remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    reset_remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    check(reset_remuxer.switchLayer(3, 9, 0),
          "layer switch used by reset test was rejected");
    const auto reset = reset_remuxer.reset();
    check(reset.has_value() &&
              reset->reason == tlvdemux::MseLayerSwitchCancelReason::Reset &&
              reset_sink.layer_switch_cancellations.size() == 1,
          "reset did not cancel its pending layer switch");
}

void test_audio_init_is_restored_when_output_is_reenabled() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.setOutputEnabled(false);
    remuxer.push(audio_unit(1, 0));
    check(sink.inits.empty(), "disabled MSE output leaked an audio init");
    remuxer.setOutputEnabled(true);
    check(sink.inits.size() == 1 && sink.inits.front().type == "audio",
          "reenabling MSE output did not restore the selected audio init");
    check(sink.segments.empty(),
          "reenabling MSE output replayed probe audio instead of awaiting playback data");
}

void test_audio_channel_limit() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink, tlvdemux::MseOptions{6});
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(audio_unit(13));
    check(sink.inits.empty(), "22.2ch AAC escaped a six-channel MSE limit");

    remuxer.push(audio_unit(6));
    check(sink.inits.size() == 1 && sink.inits.front().channels == 6,
          "5.1ch AAC was not accepted after rejecting 22.2ch");
}

void test_unlimited_22_2_channel_count() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(audio_unit(13));
    check(sink.inits.size() == 1 && sink.inits.front().channels == 24,
          "AAC channel_configuration 13 was not exposed as 24 channels");
}

void test_video_configuration_change_is_a_rap_splice_boundary() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.push(hevc_unit_with_transfer(2, step, step, false, false, 18));
    // The replacement SPS is carried with this IDR. It must not become a sample
    // under the old nclx entry, and the previous pending sample's duration is
    // exactly sealed by this new decode timestamp.
    remuxer.push(hevc_unit_with_transfer(2, 2 * step, 2 * step, true, true, 16));
    remuxer.push(hevc_unit_with_transfer(2, 3 * step, 3 * step, false, false, 16));
    remuxer.flush();

    check(sink.inits.size() == 2, "HEVC configuration change did not emit a new video init");
    check(video_color_information(sink.inits[0].data) ==
              ParsedColorInformation{9, 18, 9, false},
          "first video init lost its original HLG colour configuration");
    check(video_color_information(sink.inits[1].data) ==
              ParsedColorInformation{9, 16, 9, false},
          "replacement video init did not contain the new VUI colour configuration");
    check(sink.video_splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == 2 * step,
          "video splice did not use the replacement RAP presentation boundary");
    check(sink.events == std::vector<std::string>{
              "init:video", "segment:video", "video-splice", "init:video", "segment:video"},
          "configuration boundary event order must be old media, splice, new init, new media");

    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() == 2, "configuration change should split video media at the RAP");
    check(segments[0].samples.size() == 2 &&
              segments[0].samples.back().duration == step,
          "old pending sample was not sealed with the replacement RAP DTS");
    check(composition_timestamps({segments[0]}) == std::vector<std::int64_t>{0, step},
          "old configuration media crossed the replacement RAP boundary");
    check(composition_timestamps({segments[1]}) == std::vector<std::int64_t>{2 * step, 3 * step},
          "replacement RAP was not emitted under the new configuration");
}

void test_video_track_switch_configuration_change_preserves_old_pending_media() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.push(hevc_unit_with_transfer(2, step, step, false, false, 18));
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 3);
    auto replacement = hevc_unit_with_transfer(3, 2 * step, 2 * step, true, true, 16);
    replacement.discontinuity = true;  // libaribtlv marks the first selected RAP this way.
    remuxer.push(replacement);
    remuxer.push(hevc_unit_with_transfer(3, 3 * step, 3 * step, false, false, 16));
    remuxer.flush();

    check(sink.events == std::vector<std::string>{
              "init:video", "segment:video", "video-splice", "init:video", "segment:video"},
          "selected-video discontinuity discarded old media before the new configuration boundary");
    check(sink.inits.size() == 2 &&
              video_color_information(sink.inits[1].data) ==
                  ParsedColorInformation{9, 16, 9, false},
          "selected-video replacement did not emit its new VUI init segment");
    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() == 2 && segments[0].samples.size() == 2 &&
              segments[0].samples.back().duration == step,
          "selected-video replacement did not seal the old pending sample at the new RAP DTS");
    check(sink.video_splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == 2 * step,
          "selected-video replacement did not expose the new RAP presentation boundary");
}

void test_video_track_switch_same_configuration_is_a_splice_without_new_init() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    constexpr std::int64_t step = 100000;
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.push(hevc_unit_with_transfer(2, step, step, false, false, 18));
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 3);
    auto replacement = hevc_unit_with_transfer(3, 2 * step, 2 * step, true, true, 18);
    replacement.discontinuity = true;
    remuxer.push(replacement);
    remuxer.push(hevc_unit_with_transfer(3, 3 * step, 3 * step, false, false, 18));
    remuxer.flush();

    check(sink.inits.size() == 1,
          "same-configuration video track switch unnecessarily emitted a new init");
    check(sink.events == std::vector<std::string>{
              "init:video", "segment:video", "video-splice", "segment:video"},
          "same-configuration video track switch must splice old and new media at the RAP");
    check(sink.video_splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == 2 * step,
          "same-configuration track switch did not expose the replacement RAP boundary");
    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() == 2 && segments[0].samples.size() == 2 &&
              segments[0].samples.back().duration == step,
          "same-configuration track switch discarded the old pending media");
    check(composition_timestamps({segments[1]}) == std::vector<std::int64_t>{2 * step, 3 * step},
          "same-configuration track switch did not emit the replacement RAP media");
}

void test_multiplexed_output_has_two_tracks_and_global_sequences() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(
        sink, tlvdemux::MseOptions{0, tlvdemux::MseOutputMode::Multiplexed});
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(2));
    remuxer.flush();

    check(sink.inits.size() == 1 && sink.inits.front().type == "muxed",
          "multiplexed output must emit one shared init segment");
    const auto& init = sink.inits.front().data;
    const auto moov = find_box(init, 0, init.size(), "moov");
    check(moov.has_value(), "multiplexed init is missing moov");
    check(direct_box_count(init, moov->payload_start, moov->payload_end, "trak") == 2,
          "multiplexed init must declare video and audio tracks");
    check(sink.segments.size() == 2, "multiplexed flush must emit both tracks");
    const auto first = parse_segment(sink.segments[0].data);
    const auto second = parse_segment(sink.segments[1].data);
    check(first.sequence == 1 && second.sequence == 2,
          "multiplexed fragments must share one increasing sequence");
    check(first.track_id == 1 && second.track_id == 2,
          "multiplexed fragments must reference distinct video and audio tracks");
    check(sink.segments[0].type == "muxed" && sink.segments[1].type == "muxed",
          "multiplexed media callbacks must use the shared stream type");
}

void test_video_only_output_does_not_wait_for_audio() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.flush();

    check(sink.inits.size() == 1 && sink.inits.front().type == "video",
          "video-only output must emit its init without an audio track");
    check(sink.segments.size() == 1 && sink.segments.front().type == "video",
          "video-only output must flush its media without an audio track");
    const auto& init = sink.inits.front().data;
    const auto moov = find_box(init, 0, init.size(), "moov");
    check(moov.has_value(), "video-only init is missing moov");
    check(direct_box_count(init, moov->payload_start, moov->payload_end, "trak") == 1,
          "video-only init must declare exactly one track");
    check(video_color_information(init) ==
              ParsedColorInformation{9, 18, 9, false},
          "video init did not preserve the SPS HLG colour information as nclx");
    check(parse_segment(sink.segments.front().data).track_id == 1,
          "video-only fragment must reference the video track");
}

} // namespace

int main() {
    test_audio_switch_uses_cached_frame_boundary_without_video_rap();
    test_video_track_switch_preserves_prepared_alternate_audio();
    test_layer_switch_coordinates_video_rap_and_prepared_audio();
    test_layer_switch_replays_cached_target_video_from_requested_rap();
    test_layer_switch_waits_for_target_audio_after_video_rap();
    test_layer_switch_retries_distant_audio_at_later_video_boundary();
    test_layer_switch_uses_first_replacement_presentation_time();
    test_unspecified_media_timescale_is_not_remuxed();
    test_layer_switch_cancels_once_at_end_of_input();
    test_layer_switch_cancels_on_reposition_and_explicit_selection();
    test_audio_init_is_restored_when_output_is_reenabled();
    test_audio_channel_limit();
    test_unlimited_22_2_channel_count();
    test_video_configuration_change_is_a_rap_splice_boundary();
    test_video_track_switch_configuration_change_preserves_old_pending_media();
    test_video_track_switch_same_configuration_is_a_splice_without_new_init();
    test_multiplexed_output_has_two_tracks_and_global_sequences();
    test_video_only_output_does_not_wait_for_audio();
    test_audio_drops_non_advancing_dts();
    test_video_fragments_do_not_overlap_in_composition_time();
    test_video_fragments_do_not_overlap_with_broadcast_timescale();
    test_video_queue_bound_forces_emit_without_safe_cut();
    test_mid_stream_bla_drops_rasl();
    test_cra_after_eos_drops_rasl();
    test_plain_mid_stream_cra_keeps_rasl();
    test_radl_does_not_reopen_gate();
    std::cout << "mse remuxer tests passed\n";
}
