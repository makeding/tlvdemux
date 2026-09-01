#include <tlvdemux/mse_remuxer.hpp>
#include <tlvdemux/hevc_metadata.hpp>
#include "../src/mse/hevc_parser.hpp"
#include "mse_remuxer_test_media.hpp"

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
        for (const auto& segment : segments) {
            if (segment.type != "audio") continue;
            audio_emitted_end_at_splice = audio_emitted_end_at_splice.has_value()
                ? std::max(*audio_emitted_end_at_splice, segment.end_time_us)
                : segment.end_time_us;
        }
        splices.push_back(splice);
    }
    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        events.push_back("video-splice");
        video_splices.push_back(splice);
    }
    void onMseVideoProperties(
        const tlvdemux::MseVideoProperties& properties) override {
        video_properties.push_back(properties);
    }
    void onMseVideoRecovery(
        const tlvdemux::MseVideoRecoveryEvent& recovery) override {
        video_recovery.push_back(recovery);
    }
    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        events.push_back("layer-switch");
        layer_switches.push_back(layer);
    }
    void onMseLayerSwitchStarted(
        const tlvdemux::MseLayerSwitchStarted& started) override {
        events.push_back("layer-switch-started");
        layer_switch_starts.push_back(started);
    }
    void onMseLayerSwitchCancelled(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) override {
        events.push_back("layer-switch-cancelled");
        layer_switch_cancellations.push_back(cancelled);
    }
    void onPlaybackDamage(const tlvdemux::PlaybackDamage& damage) override {
        events.push_back("playback-damage");
        playback_damage.push_back(damage);
    }

    std::vector<tlvdemux::MseTrackInit> inits;
    std::vector<tlvdemux::MseMediaSegment> segments;
    std::vector<tlvdemux::MseAudioSplice> splices;
    std::optional<std::int64_t> audio_emitted_end_at_splice;
    std::vector<tlvdemux::MseVideoSplice> video_splices;
    std::vector<tlvdemux::MseVideoProperties> video_properties;
    std::vector<tlvdemux::MseVideoRecoveryEvent> video_recovery;
    std::vector<tlvdemux::MseLayerSwitch> layer_switches;
    std::vector<tlvdemux::MseLayerSwitchStarted> layer_switch_starts;
    std::vector<tlvdemux::MseLayerSwitchCancelled> layer_switch_cancellations;
    std::vector<tlvdemux::PlaybackDamage> playback_damage;
    std::vector<std::string> events;
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

bool video_entry_has_child(const std::vector<std::uint8_t>& init_segment,
                           const char* type) {
    const auto moov = find_box(init_segment, 0, init_segment.size(), "moov");
    if (!moov) return false;
    const auto trak = find_box(init_segment, moov->payload_start, moov->payload_end, "trak");
    if (!trak) return false;
    const auto mdia = find_box(init_segment, trak->payload_start, trak->payload_end, "mdia");
    if (!mdia) return false;
    const auto minf = find_box(init_segment, mdia->payload_start, mdia->payload_end, "minf");
    if (!minf) return false;
    const auto stbl = find_box(init_segment, minf->payload_start, minf->payload_end, "stbl");
    if (!stbl) return false;
    const auto stsd = find_box(init_segment, stbl->payload_start, stbl->payload_end, "stsd");
    if (!stsd) return false;
    const auto hvc1 = find_box(init_segment, stsd->payload_start + 8,
                               stsd->payload_end, "hvc1");
    return hvc1 && find_box(init_segment, hvc1->payload_start + 78,
                            hvc1->payload_end, type).has_value();
}

tlvdemux::AccessUnit hevc_unit_with_hdr_static_metadata() {
    auto unit = hevc_unit_with_transfer(2, 0, 0, true, true, 16);
    const std::vector<std::uint8_t> sei_payload{
        137, 24,
        0x68, 0x40, 0x38, 0x40,  // primary 0
        0x39, 0x30, 0x21, 0x90,  // primary 1
        0x18, 0x20, 0x08, 0x98,  // primary 2
        0x3a, 0x98, 0x20, 0x00,  // white point
        0x00, 0x98, 0x96, 0x80,  // max luminance
        0x00, 0x00, 0x00, 0x01,  // min luminance
        144, 4, 0x03, 0xe8, 0x01, 0xf4, 0x80};
    const auto sei = annex_b_wrap(make_simple_nal(39, escape_rbsp(sei_payload)));
    unit.data.insert(unit.data.end(), sei.begin(), sei.end());
    return unit;
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

void test_audio_forward_gap_keeps_decoder_timeline_contiguous() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    // AAC-LC at 48 kHz advances by 1024 track ticks per access unit. The
    // third AU starts three frames late, simulating the missing packet which
    // caused Chromium to reject the next audio packet in the captured stream.
    for (const auto pts : {std::int64_t{0}, std::int64_t{1024},
                           std::int64_t{4096}, std::int64_t{5120}}) {
        remuxer.push(audio_unit(1, pts));
    }
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "audio");
    check(!segments.empty(), "audio forward-gap test emitted no media");
    std::int64_t expected_dts = 0;
    std::size_t total_samples = 0;
    for (const auto& segment : segments) {
        check(std::int64_t(segment.tfdt) == expected_dts,
              "audio forward gap left a discontinuous fragment decode timeline");
        std::uint64_t segment_duration = 0;
        for (const auto& sample : segment.samples) {
            check(sample.duration == 1024,
                  "audio forward gap stretched an AAC sample duration");
            segment_duration += sample.duration;
            ++total_samples;
        }
        expected_dts += std::int64_t(segment_duration);
    }
    check(total_samples == 4,
          "audio forward-gap test lost a valid AAC packet while repairing timestamps");
}

void test_audio_source_damage_keeps_queued_media_and_decoder_timeline() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    for (const auto pts : {std::int64_t{0}, std::int64_t{1024},
                           std::int64_t{4096}, std::int64_t{5120}}) {
        auto unit = audio_unit(1, pts);
        if (pts == 4096) {
            unit.discontinuity = true;
            unit.discontinuity_reasons =
                aribtlv::DiscontinuityReason::SourceDamage;
        }
        remuxer.push(unit);
    }
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "audio");
    check(!segments.empty(), "damaged audio emitted no media");
    std::int64_t expected_dts = 0;
    std::size_t total_samples = 0;
    for (const auto& segment : segments) {
        check(std::int64_t(segment.tfdt) == expected_dts,
              "source-damage marker split the AAC decode timeline");
        std::uint64_t segment_duration = 0;
        for (const auto& sample : segment.samples) {
            check(sample.duration == 1024,
                  "source-damage marker stretched an AAC sample");
            segment_duration += sample.duration;
            ++total_samples;
        }
        expected_dts += std::int64_t(segment_duration);
    }
    check(total_samples == 4,
          "source-damage marker discarded already queued or recovered AAC media");
}

void test_video_source_damage_does_not_discard_independent_audio() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));
    remuxer.push(audio_unit(1, 1024));

    auto damaged_video = hevc_unit(2, 1'000'000, 1'000'000, true, false);
    damaged_video.discontinuity = true;
    damaged_video.discontinuity_reasons =
        aribtlv::DiscontinuityReason::SourceDamage;
    remuxer.push(damaged_video);
    remuxer.push(audio_unit(1, 2048));
    remuxer.push(audio_unit(1, 3072));
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "audio");
    std::int64_t expected_dts = 0;
    std::size_t total_samples = 0;
    for (const auto& segment : segments) {
        check(std::int64_t(segment.tfdt) == expected_dts,
              "video source damage split the independent AAC timeline");
        for (const auto& sample : segment.samples) {
            expected_dts += sample.duration;
            ++total_samples;
        }
    }
    check(total_samples == 4,
          "video source damage discarded queued independent AAC media");
}

void test_startup_source_damage_starts_at_first_rap_without_observation() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    auto first_rap = hevc_unit(2, 436'189, 436'189, true, true);
    first_rap.discontinuity = true;
    first_rap.discontinuity_reasons =
        aribtlv::DiscontinuityReason::SourceDamage;
    remuxer.push(first_rap);
    remuxer.push(hevc_unit(2, 469'556, 469'556, false, false));
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() == 1 && segments[0].tfdt == 436'189 &&
              segments[0].samples.size() == 2,
          "startup SourceDamage waited past the first real RAP");
    check(sink.video_recovery.empty(),
          "startup SourceDamage incorrectly opened a recovery observation");
}

void test_video_source_damage_waits_for_a_clean_gop_before_restart() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);

    remuxer.push(hevc_unit(2, 98'000'000, 98'000'000, true, true));
    remuxer.push(hevc_unit(2, 98'033'367, 98'033'367, false, false));

    const auto damage = [](tlvdemux::AccessUnit unit) {
        unit.discontinuity = true;
        unit.discontinuity_reasons = aribtlv::DiscontinuityReason::SourceDamage;
        return unit;
    };
    const auto damage_span = [](const std::int64_t start_us,
                                const std::int64_t recovery_us) {
        aribtlv::DamageSpan span;
        span.track_id = 2;
        span.kind = aribtlv::TrackKind::Video;
        span.codec = aribtlv::Codec::Hevc;
        span.start_time = aribtlv::Timestamp{start_us, 1'000'000};
        span.end_time = {recovery_us, 1'000'000};
        span.recovery_time = aribtlv::Timestamp{recovery_us, 1'000'000};
        span.start_input_offset = 100;
        span.end_input_offset = 200;
        span.recovery_input_offset = 300;
        span.recovery_restart_offset = 250;
        span.reasons = aribtlv::DiscontinuityReason::SourceDamage;
        span.recovered = true;
        span.recovery_random_access = true;
        return span;
    };
    remuxer.push(damage(hevc_unit(2, 98'380'000, 98'380'000, false, false)));
    remuxer.push(hevc_unit(2, 99'201'500, 99'201'500, true, false));
    remuxer.push(hevc_unit(2, 99'351'650, 99'351'650, false, false));
    remuxer.observeDamage(damage_span(98'384'005, 99'201'500));
    remuxer.push(damage(hevc_unit(2, 99'468'433, 99'468'433, true, false)));
    remuxer.push(hevc_unit(2, 99'485'117, 99'485'117, false, false));
    remuxer.observeDamage(damage_span(99'468'433, 99'735'361));
    remuxer.push(hevc_unit(2, 100'269'228, 100'269'228, true, false));
    remuxer.push(hevc_unit(2, 100'302'595, 100'302'595, false, false));
    remuxer.flush();

    const auto segments = segments_of(sink.segments, "video");
    check(segments.size() == 2,
          "source damage did not split the valid prefix and stable generation");
    check(segments[0].tfdt == 98'000'000 && segments[0].samples.size() == 2,
          "source damage discarded the complete video prefix before the loss");
    check(segments[1].tfdt == 100'269'228 && segments[1].samples.size() == 2,
          "candidate recovery islands escaped before the clean-GOP boundary");
    check(sink.video_recovery.size() == 3 &&
              sink.video_recovery[0].phase ==
                  tlvdemux::MseVideoRecoveryPhase::ObservationStarted &&
              sink.video_recovery[1].phase ==
                  tlvdemux::MseVideoRecoveryPhase::CandidateRejected &&
              sink.video_recovery[2].phase ==
                  tlvdemux::MseVideoRecoveryPhase::StableRapCommitted &&
              sink.video_recovery[0].presentation_time_us == 98'380'000 &&
              sink.video_recovery[1].presentation_time_us == 99'468'433 &&
              sink.video_recovery[2].presentation_time_us == 100'269'228,
          "source-damage recovery diagnostics lost the stable three-event contract");
}

void test_audio_configuration_change_emits_matching_init() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    constexpr std::int64_t entry_offset_us = -650638;
    remuxer.setTimestampOffset(entry_offset_us);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0, 6));
    remuxer.push(audio_unit(1, 1024, 6));
    remuxer.push(audio_unit(1, 4096, 2));
    remuxer.push(audio_unit(1, 5120, 2));
    remuxer.flush();

    std::vector<tlvdemux::MseTrackInit> audio_inits;
    for (const auto& init : sink.inits) {
        if (init.type == "audio") audio_inits.push_back(init);
    }
    check(audio_inits.size() == 2,
          "AAC channel configuration change did not emit a replacement init segment");
    check(audio_inits[0].channels == 6 && audio_inits[1].channels == 2,
          "AAC replacement init segment did not follow the 6ch-to-2ch transition");
    check(sink.splices.size() == 1,
          "AAC channel configuration change did not emit one audio splice");
    const auto segments = segments_of(sink.segments, "audio");
    std::vector<const tlvdemux::MseMediaSegment*> raw_audio_segments;
    for (const auto& segment : sink.segments) {
        if (segment.type == "audio") raw_audio_segments.push_back(&segment);
    }
    check(segments.size() == 2,
          "AAC channel configuration change did not split both media generations");
    check(raw_audio_segments.size() == segments.size(),
          "AAC parsed and observable media generations differ");
    check(segments[0].tfdt == 0 && segments[1].tfdt == 4096,
          "AAC configuration change lost its source timeline boundary");
    check(sink.splices[0].presentation_time_us == 85333 &&
              sink.splices[0].timestamp_offset_us == entry_offset_us - 42666,
          "AAC configuration change replaced the absolute entry mapping with a delta");
    const auto first_mapped_start = raw_audio_segments[1]->start_time_us +
        sink.splices[0].timestamp_offset_us;
    const auto old_mapped_end = raw_audio_segments[0]->end_time_us + entry_offset_us;
    check(std::llabs(first_mapped_start - old_mapped_end) <= 1,
          "AAC configuration splice left a mapped MSE audio gap");

    remuxer.push(audio_unit(1, 8192, 6));
    remuxer.push(audio_unit(1, 9216, 6));
    remuxer.flush();
    check(sink.splices.size() == 2 &&
              sink.splices[1].timestamp_offset_us == entry_offset_us - 85333,
          "a second AAC configuration change fell back to a zero-based offset");

    constexpr std::int64_t seek_offset_us = -1000000;
    remuxer.setTimestampOffset(seek_offset_us);
    remuxer.reposition();
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 12000, 6));
    remuxer.push(audio_unit(1, 13024, 6));
    remuxer.push(audio_unit(1, 16096, 2));
    remuxer.push(audio_unit(1, 17120, 2));
    remuxer.flush();
    check(sink.splices.size() == 3 &&
              sink.splices[2].timestamp_offset_us == seek_offset_us - 42666,
          "reposition discarded the explicit absolute AAC timestamp offset");

    TestSink selection_sink;
    tlvdemux::MseRemuxer selection_remuxer(selection_sink);
    selection_remuxer.setTimestampOffset(entry_offset_us);
    selection_remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    selection_remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    selection_remuxer.push(hevc_unit(2, 0, 0, true, true));
    for (const auto pts : {48000, 49024}) {
        selection_remuxer.push(audio_unit(1, pts, 6));
        selection_remuxer.push(audio_unit(2, pts, 2));
    }
    selection_remuxer.flush();
    const auto old_selection_end = selection_sink.segments.back().end_time_us;
    selection_remuxer.selectTrack(tlvdemux::TrackKind::Audio, 2);
    selection_remuxer.push(audio_unit(2, 50048, 2));
    selection_remuxer.flush();
    check(selection_sink.segments.back().start_time_us == old_selection_end,
          "audio track reuse applied the absolute SourceBuffer offset twice");
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

void test_alternate_audio_keeps_warming_while_selected_video_has_no_timeline() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 48; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }

    auto damaged_selected_video = hevc_unit(2, 50000, 50000, false, false);
    damaged_selected_video.discontinuity = true;
    remuxer.push(damaged_selected_video);
    for (std::int64_t index = 48; index < 120; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }

    check(remuxer.switchLayer(3, 9, 0),
          "layer switch after selected-video damage was rejected");
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    replacement.discontinuity = true;
    remuxer.push(replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    check(sink.layer_switches.size() == 1,
          "alternate audio stopped warming while selected video lacked a timeline offset");
    check(sink.layer_switches.front().audio_presentation_time_us == 100000,
          "alternate audio was not mapped to the first replacement video RAP");
}

void test_startup_fallback_stages_splice_init_media_without_preferred_video() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        remuxer.push(audio_unit(9, index * frame));
    }
    check(std::none_of(sink.inits.begin(), sink.inits.end(),
              [](const tlvdemux::MseTrackInit& init) { return init.type == "video"; }),
          "test unexpectedly created a preferred video SourceBuffer init");

    remuxer.push(hevc_unit(3, 100000, 100000, true, true));
    const auto accepted = remuxer.push(
        hevc_unit(3, 133367, 133367, false, false));
    check(accepted.has_value() && accepted->video_track_id == 3 &&
              accepted->audio_track_id == 9 &&
              accepted->earliest_presentation_time_us == 0,
          "startup fallback was not accepted at the current playback entry");
    for (std::int64_t index = 2; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    check(sink.layer_switch_starts.size() == 1 &&
              sink.layer_switch_starts.front().reason ==
                  tlvdemux::MseLayerSwitchReason::HealthDegradation,
          "startup fallback did not publish one health-degradation acceptance");
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().video_presentation_time_us == 100000 &&
              sink.layer_switches.front().audio_presentation_time_us == 100000,
          "startup fallback did not map A/V to the first rainfall RAP");
    check(sink.video_splices.size() == 1 && sink.splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == 100000 &&
              sink.splices.front().presentation_time_us == 100000 &&
              sink.video_splices.front().timestamp_offset_us == -100000 &&
              sink.splices.front().timestamp_offset_us == -100000,
          "startup fallback did not preserve source RAP while mapping MSE output to zero");
    const auto start = std::find(
        sink.events.begin(), sink.events.end(), "layer-switch-started");
    const auto splice = std::find(start, sink.events.end(), "video-splice");
    const auto init = std::find(splice, sink.events.end(), "init:video");
    const auto media = std::find(init, sink.events.end(), "segment:video");
    check(start < splice && splice < init && init < media,
          "startup staging was not logical splice -> rainfall init -> media");
    check(sink.playback_damage.empty(),
          "startup fallback leaked preferred-layer seek advice");

    remuxer.push(hevc_unit(3, 721008, 721008, false, false, 180000));
    remuxer.flush();
    const auto video_segments = segments_of(sink.segments, "video");
    std::optional<std::int64_t> previous_end;
    for (const auto& segment : video_segments) {
        check(!previous_end || std::int64_t(segment.tfdt) >= *previous_end,
              "startup-switch completion overlapped the next video fragment");
        auto end = std::int64_t(segment.tfdt);
        for (const auto& sample : segment.samples) end += sample.duration;
        previous_end = end;
    }
}

void test_manual_startup_layer_switch_maps_to_playback_entry() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    check(remuxer.switchLayerAtPlaybackEntry(3, 9, 0),
          "manual startup rainfall switch was rejected");
    remuxer.push(hevc_unit(3, 100000, 100000, true, true));
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    check(sink.layer_switches.size() == 1,
          "manual startup rainfall switch did not complete");
    check(sink.video_splices.size() == 1 && sink.splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == 100000 &&
              sink.splices.front().presentation_time_us == 100000 &&
              sink.video_splices.front().timestamp_offset_us == -100000 &&
              sink.splices.front().timestamp_offset_us == -100000,
          "manual startup rainfall switch did not map common A/V to timestamp zero");
}

aribtlv::DamageSpan severe_source_damage(const std::uint64_t track_id) {
    aribtlv::DamageSpan damage;
    damage.track_id = track_id;
    damage.kind = aribtlv::TrackKind::Video;
    damage.codec = aribtlv::Codec::Hevc;
    damage.start_time = aribtlv::Timestamp{5000000, 1000000};
    damage.end_time = {5500000, 1000000};
    damage.recovery_time = aribtlv::Timestamp{8000000, 1000000};
    damage.start_input_offset = 100;
    damage.end_input_offset = 200;
    damage.recovery_input_offset = 300;
    damage.recovery_restart_offset = 250;
    damage.reasons = aribtlv::DiscontinuityReason::SourceDamage;
    damage.recovered = true;
    damage.recovery_random_access = true;
    return damage;
}

aribtlv::DamageSpan unrecovered_source_damage(const std::uint64_t track_id) {
    auto damage = severe_source_damage(track_id);
    damage.recovery_time.reset();
    damage.recovery_input_offset = 0;
    damage.recovery_restart_offset = 0;
    damage.recovered = false;
    damage.recovery_random_access = false;
    return damage;
}

void warm_automatic_layer_pair(tlvdemux::MseRemuxer& remuxer) {
    constexpr std::int64_t audio_frame = 1024;
    for (std::int64_t index = 0; index < 300; ++index) {
        remuxer.push(audio_unit(1, index * audio_frame));
        remuxer.push(audio_unit(9, index * audio_frame));
    }
    for (std::int64_t timestamp = 0; timestamp <= 5000000;
         timestamp += 500000) {
        const bool rap = timestamp % 1000000 == 0;
        remuxer.push(hevc_unit(2, timestamp, timestamp, rap, timestamp == 0));
        remuxer.push(hevc_unit(3, timestamp, timestamp, rap, timestamp == 0));
    }
}

void test_source_damage_prefers_accepted_automatic_layer_switch() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 1});
    warm_automatic_layer_pair(remuxer);

    const auto accepted = remuxer.observeDamage(severe_source_damage(2));
    check(accepted.has_value() && accepted->video_track_id == 3 &&
              accepted->audio_track_id == 1,
          "severe source damage did not accept the prepared rainfall layer");
    for (std::int64_t timestamp = 5500000; timestamp <= 6500000;
         timestamp += 100000) {
        remuxer.push(hevc_unit(
            3, timestamp, timestamp, timestamp == 6000000, false));
    }
    check(sink.layer_switch_starts.size() == 1 &&
              sink.layer_switch_starts.front().reason ==
                  tlvdemux::MseLayerSwitchReason::SourceDamage,
          "source-damage layer switch did not publish its accepted transition");
    check(sink.layer_switches.size() == 1,
          "source-damage rainfall layer switch did not complete");
    check(sink.playback_damage.empty(),
          "completed source-damage layer switch leaked the held seek advice");
}

void test_source_damage_waits_then_seeks_at_real_recovery_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    for (std::int64_t timestamp = 0; timestamp <= 5000000;
         timestamp += 500000) {
        remuxer.push(hevc_unit(
            2, timestamp, timestamp, timestamp % 1000000 == 0, false));
    }

    check(!remuxer.observeDamage(unrecovered_source_damage(2)).has_value() &&
              sink.playback_damage.size() == 1 &&
              sink.playback_damage.front().action ==
                  tlvdemux::PlaybackRecoveryAction::WaitForRecovery,
          "unprepared rainfall layer did not publish wait-for-recovery");
    remuxer.push(hevc_unit(2, 6000000, 6000000, true, false));
    check(sink.playback_damage.size() == 2 &&
              sink.playback_damage.back().action ==
                  tlvdemux::PlaybackRecoveryAction::Seek &&
              sink.playback_damage.back().recovery_time_us ==
                  std::optional<std::int64_t>{6000000},
          "preferred layer did not seek at its first real recovery RAP");
    remuxer.endOfStream();
    check(sink.playback_damage.size() == 2,
          "end of input invented an additional recovery target");
}

void test_fixed_mode_keeps_immediate_source_damage_seek() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.observeDamage(severe_source_damage(2));
    check(sink.layer_switch_starts.empty() && sink.playback_damage.size() == 1 &&
              sink.playback_damage.front().action ==
                  tlvdemux::PlaybackRecoveryAction::Seek,
          "fixed video selection did not preserve immediate damage seek advice");
}

void test_reposition_discards_retained_source_damage() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    remuxer.push(hevc_unit(2, 0, 0, true, false));
    remuxer.observeDamage(unrecovered_source_damage(2));
    check(sink.playback_damage.size() == 1 &&
              sink.playback_damage.front().action ==
                  tlvdemux::PlaybackRecoveryAction::WaitForRecovery,
          "test did not establish an unrecovered damage wait");
    remuxer.reposition();
    remuxer.push(hevc_unit(2, 6000000, 6000000, true, false));
    remuxer.endOfStream();
    check(sink.playback_damage.size() == 1,
          "reposition leaked a stale recovery seek");
}

void test_layer_switch_coordinates_video_rap_and_prepared_audio() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        auto alternate = audio_unit(9, index * frame);
        alternate.discontinuity = index == 12;
        remuxer.push(alternate);
    }
    check(remuxer.switchLayer(3, 9, audio_time_us(4 * frame)),
          "valid layer switch request was rejected");
    check(sink.layer_switch_starts.size() == 1 &&
              sink.layer_switch_starts.front().reason ==
                  tlvdemux::MseLayerSwitchReason::Manual,
          "manual layer switch did not emit its accepted start event");
    auto replacement = hevc_unit(3, 100000, 100000, true, true);
    remuxer.push(replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }

    constexpr std::int64_t expected_boundary = 100000;
    check(sink.layer_switches.size() == 1,
          "prepared A/V layer switch did not emit completion");
    const auto& completed = sink.layer_switches.front();
    check(completed.video_track_id == 3 && completed.audio_track_id == 9 &&
              completed.video_presentation_time_us == expected_boundary &&
              completed.audio_presentation_time_us == expected_boundary,
          "layer switch did not map replacement A/V to the first target RAP");
    check(sink.video_splices.size() == 1 && sink.splices.size() == 1 &&
              sink.splices.front().presentation_time_us == expected_boundary &&
              sink.video_splices.front().timestamp_offset_us == 0 &&
              sink.splices.front().timestamp_offset_us == 0,
          "layer switch did not splice both SourceBuffers");
    check(sink.audio_emitted_end_at_splice.has_value() &&
              *sink.audio_emitted_end_at_splice > expected_boundary + 1000000,
          "test did not prebuffer old audio beyond the first target RAP");
    check(sink.splices.front().presentation_time_us <
              *sink.audio_emitted_end_at_splice,
          "old audio future tail postponed the layer switch instead of being removed");
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

void test_automatic_mode_supersedes_pending_manual_layer_switch() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));

    constexpr std::int64_t frame = 1024;
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(audio_unit(1, index * frame));
        remuxer.push(audio_unit(9, index * frame));
    }
    check(remuxer.switchLayer(3, 9, 100000),
          "manual rainfall switch was not accepted for automatic-mode recovery test");
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});

    check(sink.layer_switch_cancellations.size() == 1 &&
              sink.layer_switch_cancellations.front().video_track_id == 3 &&
              sink.layer_switch_cancellations.front().previous_video_track_id == 2 &&
              sink.layer_switch_cancellations.front().reason ==
                  tlvdemux::MseLayerSwitchCancelReason::SelectionChanged,
          "automatic mode did not supersede the unfinished manual rainfall switch");
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
    for (std::int64_t index = 47; index < 170; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    const auto segment_count = sink.segments.size();
    check(remuxer.switchLayer(3, 9, 900000),
          "cached layer switch request was rejected");

    check(sink.layer_switches.size() == 1,
          "cached target video was not replayed synchronously");
    check(sink.layer_switches.front().video_presentation_time_us == 1200000,
          "cached switch did not prefer a nearby closed IRAP over CRA");
    constexpr std::int64_t expected_audio_boundary = 1200000;
    check(sink.layer_switches.front().audio_presentation_time_us == expected_audio_boundary,
          "cached video replay did not map prepared target audio to its RAP");
    check(std::any_of(sink.segments.begin(), sink.segments.end(),
              [](const tlvdemux::MseMediaSegment& segment) {
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
    for (std::int64_t index = 0; index <= 97; ++index) {
        remuxer.push(audio_unit(9, index * frame));
    }
    check(sink.video_splices.empty() && sink.layer_switches.empty(),
          "layer switch exposed target video before audio had 2s prepared");
    remuxer.push(audio_unit(9, 98 * frame));
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().audio_presentation_time_us == 100000,
          "layer switch did not complete after target audio had 2s prepared");
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
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(audio_unit(9, distant_start + index * frame));
    }

    check(sink.layer_switches.empty() && sink.video_splices.empty() &&
              sink.splices.empty() && sink.layer_switch_cancellations.empty(),
          "distant audio boundary was committed or cancelled before a later RAP");

    auto aligned_replacement = hevc_unit(3, 5100000, 5100000, true, false);
    remuxer.push(aligned_replacement);
    for (std::int64_t index = 1; index <= 20; ++index) {
        const auto timestamp = 5100000 + index * 33367;
        remuxer.push(hevc_unit(3, timestamp, timestamp, false, false));
    }
    constexpr std::int64_t expected_audio_boundary = 5100000;
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().video_presentation_time_us == 5100000 &&
              sink.layer_switches.front().audio_presentation_time_us ==
                  expected_audio_boundary,
          "layer switch did not retry at an A/V-aligned video RAP");
    const auto splice = std::find(sink.events.begin(), sink.events.end(), "video-splice");
    const auto init = std::find(splice, sink.events.end(), "init:video");
    const auto media = std::find(splice, sink.events.end(), "segment:video");
    check(splice < init && init < media,
          "retried video staging did not regenerate splice -> target init -> media");
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

void test_recorded_seek_audio_flush_seals_subthreshold_prefix_only() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(audio_unit(1, 0));
    remuxer.push(audio_unit(1, 1024));
    check(sink.segments.empty(),
          "short Recorded landing AAC unexpectedly reached the normal fragment threshold");

    remuxer.flushRecordedSeekAudio();
    const auto segments = segments_of(sink.segments, "audio");
    check(segments.size() == 1 && segments.front().samples.size() == 2,
          "Recorded seek did not seal its real selected-AAC prefix");
    check(std::all_of(sink.segments.begin(), sink.segments.end(),
              [](const tlvdemux::MseMediaSegment& segment) {
                  return segment.type == "audio";
              }),
          "Recorded AAC prefix flush emitted another track");
}

void test_video_configuration_change_is_a_rap_splice_boundary() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    constexpr std::int64_t entry_offset_us = -534666;
    remuxer.setTimestampOffset(entry_offset_us);
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
              sink.video_splices.front().presentation_time_us == 2 * step &&
              sink.video_splices.front().timestamp_offset_us == entry_offset_us,
          "video splice lost the complete startup timestamp mapping");
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

void test_sdr_in_hlg_rewrites_video_colour_signalling() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setSdrInHlg(2, true);
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.flush();

    check(sink.inits.size() == 1,
          "SDR-in-HLG video did not emit exactly one init segment");
    check(video_color_information(sink.inits.front().data) ==
              ParsedColorInformation{9, 1, 9, false},
          "SDR-in-HLG video did not remove HLG transfer signalling");
}

void test_hlg_sdr_prototype_emits_internal_carrier_signalling() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setHlgSdrPrototype(2, true);
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.flush();

    check(sink.inits.size() == 1,
          "HLG-SDR prototype did not emit exactly one init segment");
    check(video_color_information(sink.inits.front().data) ==
              ParsedColorInformation{1, 13, 9, false},
          "HLG-SDR prototype did not emit the 1/13/9 carrier");
    check(sink.video_properties.size() == 1 &&
              sink.video_properties.front().source_color ==
                  tlvdemux::MseVideoColor{9, 18, 9, false} &&
              sink.video_properties.front().output_color ==
                  tlvdemux::MseVideoColor{1, 13, 9, false} &&
              sink.video_properties.front().hlg_sdr_prototype &&
              !sink.video_properties.front().sdr_in_hlg,
          "HLG-SDR prototype did not expose source and carrier state");
}

void test_b60_and_sps_colour_mismatch_is_reported_without_rewriting_sps() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setVideoSignalling(2, tlvdemux::MseVideoSignalling{2, 4});
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.flush();

    check(sink.video_properties.size() == 1 &&
              sink.video_properties.front().source_signalling.has_value() &&
              sink.video_properties.front().source_signalling->hdr_wcg_idc == 2 &&
              sink.video_properties.front().source_signalling->
                  video_transfer_characteristics == 4 &&
              sink.video_properties.front().source_signalling_mismatch &&
              video_color_information(sink.inits.front().data) ==
                  ParsedColorInformation{9, 18, 9, false},
          "B60/SPS mismatch was not reported without changing coded colour");
}

void test_b60_and_sps_colour_match_is_preserved_without_mismatch() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setVideoSignalling(2, tlvdemux::MseVideoSignalling{1, 5});
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.flush();

    check(sink.video_properties.size() == 1 &&
              sink.video_properties.front().source_signalling.has_value() &&
              sink.video_properties.front().source_signalling->hdr_wcg_idc == 1 &&
              sink.video_properties.front().source_signalling->
                  video_transfer_characteristics == 5 &&
              !sink.video_properties.front().source_signalling_mismatch &&
              video_color_information(sink.inits.front().data) ==
                  ParsedColorInformation{9, 18, 9, false},
          "matching B60/SPS colour signalling was not preserved");
}

void test_sdr_in_hlg_policy_change_reconfigures_at_next_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.push(hevc_unit_with_transfer(2, 0, 0, true, true, 18));
    remuxer.push(hevc_unit_with_transfer(2, 100000, 100000, false, false, 18));
    remuxer.setSdrInHlg(2, true);
    remuxer.push(hevc_unit_with_transfer(2, 200000, 200000, true, false, 18));
    remuxer.flush();

    check(sink.inits.size() == 2,
          "late SDR-in-HLG policy change did not emit a new init at the next RAP");
    check(video_color_information(sink.inits[1].data) ==
              ParsedColorInformation{9, 1, 9, false},
          "late SDR-in-HLG policy change did not remove HLG transfer signalling");
    check(sink.video_properties.size() == 2 &&
              sink.video_properties[0].output_color->transfer == 18 &&
              sink.video_properties[1].output_color->primaries == 9 &&
              sink.video_properties[1].output_color->transfer == 1 &&
              sink.video_properties[1].output_color->matrix == 9 &&
              sink.video_properties[1].sdr_in_hlg,
          "late SDR-in-HLG policy change did not push the effective video state");

    remuxer.setSdrInHlg(2, false);
    remuxer.push(hevc_unit_with_transfer(2, 300000, 300000, true, false, 18));
    remuxer.flush();
    check(sink.inits.size() == 3 &&
              video_color_information(sink.inits[2].data) ==
                  ParsedColorInformation{9, 18, 9, false},
          "disabling SDR-in-HLG did not restore HLG at the next RAP");
    check(sink.video_properties.size() == 3 &&
              sink.video_properties[2].output_color->transfer == 18 &&
              !sink.video_properties[2].sdr_in_hlg,
          "disabling SDR-in-HLG did not push the restored HLG state");
}

void test_hevc_hdr_static_metadata_reaches_mp4_and_properties() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    auto unit = hevc_unit_with_hdr_static_metadata();
    bool has_sei_nalu = false;
    for (const auto& nalu : tlvdemux::detail::mse::annex_b_views(unit.data)) {
        has_sei_nalu = has_sei_nalu || nalu.type == 39;
    }
    check(has_sei_nalu, "HEVC static HDR fixture did not contain a prefix SEI NAL");
    const auto metadata = tlvdemux::parse_hevc_video_metadata(unit.data);
    check(metadata.has_value() && metadata->color ==
              tlvdemux::HevcColorInformation{9, 16, 9, false},
          "public HEVC metadata API did not expose SPS VUI colour");
    check(metadata->hdr_static_metadata.has_value() &&
              metadata->hdr_static_metadata->has_mastering_display &&
              metadata->hdr_static_metadata->has_content_light &&
              metadata->hdr_static_metadata->max_content_light_level == 1000 &&
              metadata->hdr_static_metadata->max_pic_average_light_level == 500,
          "public HEVC metadata API did not expose static HDR SEI");
    remuxer.push(unit);
    remuxer.flush();

    check(sink.inits.size() == 1,
          "HEVC static HDR metadata did not emit one video init");
    check(sink.video_properties.size() == 1 &&
              sink.video_properties.front().hdr_static_metadata.has_value(),
          "HEVC static HDR metadata was not parsed from the access unit");
    check(video_entry_has_child(sink.inits.front().data, "mdcv"),
          "HEVC static HDR metadata did not emit mdcv");
    check(video_entry_has_child(sink.inits.front().data, "clli"),
          "HEVC static HDR metadata did not emit clli");
    check(sink.video_properties.size() == 1 &&
              sink.video_properties.front().hdr_static_metadata.has_value() &&
              sink.video_properties.front().hdr_static_metadata->has_mastering_display &&
              sink.video_properties.front().hdr_static_metadata->has_content_light &&
              sink.video_properties.front().hdr_static_metadata->max_content_light_level ==
                  1000 &&
              sink.video_properties.front().hdr_static_metadata->max_pic_average_light_level ==
                  500,
          "HEVC static HDR metadata was not exposed at the video boundary");
}

} // namespace

int main() {
    test_audio_switch_uses_cached_frame_boundary_without_video_rap();
    test_video_track_switch_preserves_prepared_alternate_audio();
    test_alternate_audio_keeps_warming_while_selected_video_has_no_timeline();
    test_startup_fallback_stages_splice_init_media_without_preferred_video();
    test_manual_startup_layer_switch_maps_to_playback_entry();
    test_source_damage_prefers_accepted_automatic_layer_switch();
    test_source_damage_waits_then_seeks_at_real_recovery_rap();
    test_fixed_mode_keeps_immediate_source_damage_seek();
    test_reposition_discards_retained_source_damage();
    test_layer_switch_coordinates_video_rap_and_prepared_audio();
    test_automatic_mode_supersedes_pending_manual_layer_switch();
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
    test_recorded_seek_audio_flush_seals_subthreshold_prefix_only();
    test_video_configuration_change_is_a_rap_splice_boundary();
    test_video_track_switch_configuration_change_preserves_old_pending_media();
    test_video_track_switch_same_configuration_is_a_splice_without_new_init();
    test_multiplexed_output_has_two_tracks_and_global_sequences();
    test_video_only_output_does_not_wait_for_audio();
    test_sdr_in_hlg_rewrites_video_colour_signalling();
    test_hlg_sdr_prototype_emits_internal_carrier_signalling();
    test_b60_and_sps_colour_mismatch_is_reported_without_rewriting_sps();
    test_b60_and_sps_colour_match_is_preserved_without_mismatch();
    test_sdr_in_hlg_policy_change_reconfigures_at_next_rap();
    test_hevc_hdr_static_metadata_reaches_mp4_and_properties();
    test_audio_drops_non_advancing_dts();
    test_audio_forward_gap_keeps_decoder_timeline_contiguous();
    test_audio_source_damage_keeps_queued_media_and_decoder_timeline();
    test_video_source_damage_does_not_discard_independent_audio();
    test_startup_source_damage_starts_at_first_rap_without_observation();
    test_video_source_damage_waits_for_a_clean_gop_before_restart();
    test_audio_configuration_change_emits_matching_init();
    test_video_fragments_do_not_overlap_in_composition_time();
    test_video_fragments_do_not_overlap_with_broadcast_timescale();
    test_video_queue_bound_forces_emit_without_safe_cut();
    test_mid_stream_bla_drops_rasl();
    test_cra_after_eos_drops_rasl();
    test_plain_mid_stream_cra_keeps_rasl();
    test_radl_does_not_reopen_gate();
    std::cout << "mse remuxer tests passed\n";
}
