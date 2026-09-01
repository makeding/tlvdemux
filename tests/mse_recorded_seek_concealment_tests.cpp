#include <tlvdemux/mse_remuxer.hpp>
#include "mse_remuxer_test_media.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
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
    }
    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        segments.push_back(std::move(segment));
    }
    void onMseAudioSplice(const tlvdemux::MseAudioSplice&) override {
        events.push_back("audio-splice");
    }
    void onMseVideoSplice(const tlvdemux::MseVideoSplice&) override {
        events.push_back("video-splice");
    }
    std::vector<tlvdemux::MseMediaSegment> segments;
    std::vector<std::string> events;
};

std::uint32_t read_u32(const std::vector<std::uint8_t>& data,
                       const std::size_t offset) {
    return (std::uint32_t(data[offset]) << 24) |
        (std::uint32_t(data[offset + 1]) << 16) |
        (std::uint32_t(data[offset + 2]) << 8) |
        std::uint32_t(data[offset + 3]);
}

std::uint64_t read_u64(const std::vector<std::uint8_t>& data,
                       const std::size_t offset) {
    return (std::uint64_t(read_u32(data, offset)) << 32) |
        std::uint64_t(read_u32(data, offset + 4));
}

std::int32_t read_i32(const std::vector<std::uint8_t>& data,
                      const std::size_t offset) {
    return static_cast<std::int32_t>(read_u32(data, offset));
}

struct BoxRange { std::size_t payload_start, payload_end; };

std::optional<BoxRange> find_box(const std::vector<std::uint8_t>& data,
                                 const std::size_t start,
                                 const std::size_t end,
                                 const char* type) {
    for (std::size_t offset = start; offset + 8 <= end;) {
        const auto size = read_u32(data, offset);
        if (size < 8 || offset + size > end) break;
        if (std::equal(type, type + 4,
                       data.begin() + static_cast<std::ptrdiff_t>(offset) + 4)) {
            return BoxRange{offset + 8, offset + size};
        }
        offset += size;
    }
    return std::nullopt;
}

struct ParsedSample {
    std::uint32_t duration = 0;
    std::uint32_t size = 0;
    std::int32_t composition_offset = 0;
};

struct ParsedSegment {
    std::uint64_t tfdt = 0;
    std::vector<ParsedSample> samples;
    std::vector<std::vector<std::uint8_t>> payloads;
};

ParsedSegment parse_segment(const std::vector<std::uint8_t>& data) {
    const auto moof = find_box(data, 0, data.size(), "moof");
    check(moof.has_value(), "segment has no moof");
    const auto traf = find_box(data, moof->payload_start, moof->payload_end, "traf");
    check(traf.has_value(), "segment has no traf");
    const auto tfdt = find_box(data, traf->payload_start, traf->payload_end, "tfdt");
    const auto trun = find_box(data, traf->payload_start, traf->payload_end, "trun");
    const auto mdat = find_box(data, 0, data.size(), "mdat");
    check(tfdt.has_value() && trun.has_value(), "segment has no tfdt/trun");
    check(mdat.has_value(), "segment has no mdat");
    ParsedSegment result;
    result.tfdt = read_u64(data, tfdt->payload_start + 4);
    const auto count = read_u32(data, trun->payload_start + 4);
    auto payload_offset = mdat->payload_start;
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto base = trun->payload_start + 12 + std::size_t(index) * 16;
        const ParsedSample sample{
            read_u32(data, base), read_u32(data, base + 4),
            read_i32(data, base + 12)};
        check(payload_offset + sample.size <= mdat->payload_end,
              "sample payload exceeds mdat");
        result.samples.push_back(sample);
        result.payloads.emplace_back(
            data.begin() + static_cast<std::ptrdiff_t>(payload_offset),
            data.begin() + static_cast<std::ptrdiff_t>(payload_offset + sample.size));
        payload_offset += sample.size;
    }
    return result;
}

std::vector<ParsedSegment> segments_of(
    const std::vector<tlvdemux::MseMediaSegment>& segments,
    const std::string& type) {
    std::vector<ParsedSegment> result;
    for (const auto& segment : segments) {
        if (segment.type == type) result.push_back(parse_segment(segment.data));
    }
    return result;
}

std::vector<std::int64_t> composition_timestamps(
    const std::vector<ParsedSegment>& segments) {
    std::vector<std::int64_t> result;
    for (const auto& segment : segments) {
        auto dts = static_cast<std::int64_t>(segment.tfdt);
        for (const auto& sample : segment.samples) {
            result.push_back(dts + sample.composition_offset);
            dts += sample.duration;
        }
    }
    return result;
}

std::vector<std::uint8_t> loas_frame() {
    BitWriter writer;
    writer.bits(0, 1); writer.bits(0, 1); writer.bits(1, 1);
    writer.bits(0, 6); writer.bits(0, 4); writer.bits(0, 3);
    writer.bits(2, 5); writer.bits(3, 4); writer.bits(2, 4);
    writer.bits(0, 1); writer.bits(0, 1); writer.bits(0, 1);
    writer.bits(0, 3); writer.bits(0, 8); writer.bits(0, 1); writer.bits(0, 1);
    writer.bits(1, 8); writer.bits(0xaa, 8);
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

tlvdemux::AccessUnit audio_unit(const std::int64_t pts) {
    tlvdemux::AccessUnit unit;
    unit.track_id = 1;
    unit.codec = tlvdemux::Codec::AacLatm;
    unit.data = loas_frame();
    unit.pts = {pts, 48000};
    unit.dts = unit.pts;
    return unit;
}

aribtlv::DamageSpan damage_span(const std::int64_t start_us,
                                const std::int64_t recovery_us) {
    aribtlv::DamageSpan span;
    span.track_id = 2;
    span.kind = aribtlv::TrackKind::Video;
    span.codec = aribtlv::Codec::Hevc;
    span.start_time = aribtlv::Timestamp{start_us, 1'000'000};
    span.end_time = {recovery_us, 1'000'000};
    span.recovery_time = aribtlv::Timestamp{recovery_us, 1'000'000};
    span.reasons = aribtlv::DiscontinuityReason::SourceDamage;
    span.recovered = true;
    span.recovery_random_access = true;
    return span;
}

tlvdemux::AccessUnit damaged(tlvdemux::AccessUnit unit) {
    unit.discontinuity = true;
    unit.discontinuity_reasons = aribtlv::DiscontinuityReason::SourceDamage;
    return unit;
}

void push_damage_episode(tlvdemux::MseRemuxer& remuxer) {
    remuxer.push(damaged(hevc_unit(2, 98'380'000, 98'380'000, false, false)));
    remuxer.push(hevc_unit(2, 99'201'500, 99'201'500, true, false));
    remuxer.observeDamage(damage_span(98'384'005, 99'201'500));
    remuxer.push(damaged(hevc_unit(2, 99'468'433, 99'468'433, true, false)));
    remuxer.observeDamage(damage_span(99'468'433, 99'735'361));
    remuxer.push(hevc_unit(2, 100'269'228, 100'269'228, true, false));
    remuxer.push(hevc_unit(2, 100'302'595, 100'302'595, false, false));
}

void test_previous_frame_fill_and_continuous_aac() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.setRecordedSeekConcealmentTarget(99'000'000);
    remuxer.push(hevc_unit(2, 98'000'000, 98'000'000, true, true));
    remuxer.push(hevc_unit(2, 98'033'367, 98'033'367, false, false));
    for (const auto timestamp : {4'751'360LL, 4'752'384LL, 4'753'408LL}) {
        remuxer.push(audio_unit(timestamp));
    }
    push_damage_episode(remuxer);
    remuxer.flush();

    const auto video = segments_of(sink.segments, "video");
    check(composition_timestamps(video) == std::vector<std::int64_t>{
              98'000'000, 98'033'367, 100'269'228, 100'302'595},
          "previous-frame fill moved the stable RAP");
    check(video.size() >= 2 && video[1].tfdt == 98'033'367 &&
              video[1].samples.front().duration == 2'235'861,
          "previous frame did not freeze to the stable RAP decode boundary");
    const auto audio = segments_of(sink.segments, "audio");
    const auto audio_pts = composition_timestamps(audio);
    check(audio_pts == std::vector<std::int64_t>{4'751'360, 4'752'384, 4'753'408},
          "concealment changed the AAC timeline");
    check(std::all_of(audio.begin(), audio.end(), [](const ParsedSegment& segment) {
        return std::all_of(segment.samples.begin(), segment.samples.end(),
            [](const ParsedSample& sample) { return sample.duration == 1024; });
    }), "concealment stretched or duplicated AAC");
    check(audio_pts.front() <= 4'752'000 && audio_pts.front() + 1024 > 4'752'000,
          "AAC and concealed video do not intersect at the target");
}

void test_stable_rap_fill_without_previous_frame() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setRecordedSeekConcealmentTarget(99'000'000);
    remuxer.push(damaged(hevc_unit(2, 99'201'500, 99'201'500, true, true)));
    remuxer.observeDamage(damage_span(98'384'005, 99'201'500));
    remuxer.push(hevc_unit(2, 100'269'228, 100'269'228, true, false));
    remuxer.push(hevc_unit(2, 100'302'595, 100'302'595, false, false));
    remuxer.flush();

    const auto video = segments_of(sink.segments, "video");
    check(composition_timestamps(video) == std::vector<std::int64_t>{
              99'000'000, 100'269'228, 100'302'595},
          "stable-RAP fill moved the original RAP");
    check(!video.empty() && video.front().tfdt == 99'000'000 &&
              video.front().samples.front().duration == 1'269'228,
          "stable-RAP fill does not end at the original decode boundary");
    std::vector<std::uint32_t> sizes;
    std::vector<std::vector<std::uint8_t>> payloads;
    for (const auto& segment : video) {
        for (const auto& sample : segment.samples) sizes.push_back(sample.size);
        payloads.insert(payloads.end(), segment.payloads.begin(), segment.payloads.end());
    }
    check(sizes.size() >= 2 && sizes[0] == sizes[1],
          "target filler did not reuse the stable RAP bytes");
    check(payloads.size() >= 2 && payloads[0] == payloads[1],
          "target filler is not byte-identical to the decodable stable RAP");
}

void test_target_outside_damage_is_unchanged() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.setRecordedSeekConcealmentTarget(97'000'000);
    remuxer.push(hevc_unit(2, 98'000'000, 98'000'000, true, true));
    remuxer.push(hevc_unit(2, 98'033'367, 98'033'367, false, false));
    remuxer.setRecordedSeekConcealmentTarget(std::nullopt);
    push_damage_episode(remuxer);
    remuxer.flush();
    const auto video = segments_of(sink.segments, "video");
    check(video.size() == 2 && video[0].tfdt == 98'000'000 &&
              video[0].samples.size() == 2 &&
              video[0].samples[0].duration == 33'367 &&
              video[0].samples[1].duration == 33'367 &&
              video[1].tfdt == 100'269'228 && video[1].samples.size() == 2,
          "target outside damage changed normal output");
}

void test_closed_picture_repeats_over_audio_window() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.push(hevc_unit(2, 1'000'000, 1'000'000, true, true));
    remuxer.push(hevc_unit(2, 1'033'367, 1'033'367, false, false));
    check(remuxer.repeatLastClosedVideoWindow(2'000'000, 2'100'000),
          "last closed picture could not cover the canonical AAC window");
    remuxer.flush();

    const auto video = segments_of(sink.segments, "video");
    const auto timestamps = composition_timestamps(video);
    check(timestamps == std::vector<std::int64_t>{
              1'000'000, 1'033'367, 2'000'000, 2'033'367, 2'066'734},
          "frozen video timestamps are not strictly monotonic across the AAC window");
    std::vector<std::vector<std::uint8_t>> payloads;
    for (const auto& segment : video) {
        payloads.insert(payloads.end(), segment.payloads.begin(), segment.payloads.end());
    }
    check(payloads.size() == 5 && payloads[0] == payloads[2] &&
              payloads[2] == payloads[3] && payloads[3] == payloads[4],
          "frozen samples are not byte-identical copies of the prior closed picture");
}

void test_cra_picture_survives_reposition_for_exact_audio_window() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.push(hevc_unit(
        2, 1'000'000, 1'010'000, std::vector<unsigned>{21}, true));

    // A Recorded byte landing resets the active HEVC muxer and its Mp4Track.
    // The retained CRA must carry enough configuration to become the prior
    // usable picture for the AAC-first transaction after that reposition.
    remuxer.reposition();
    check(remuxer.repeatLastClosedVideoWindow(2'000'000, 2'100'000),
          "a decodable CRA did not survive Recorded reposition");
    remuxer.flush();

    const auto video = segments_of(sink.segments, "video");
    check(composition_timestamps(video) == std::vector<std::int64_t>{
              2'000'000, 2'033'367, 2'066'734},
          "the repositioned CRA did not map exactly over the AAC window");
    check(!video.empty() && video.front().tfdt == 1'990'000,
          "the repeated CRA lost its original composition offset");
}

void test_closed_picture_is_cleared_before_a_new_audio_window_probe() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.push(hevc_unit(2, 10'000'000, 10'000'000, true, true));
    remuxer.clearLastClosedVideoPicture();
    check(!remuxer.repeatLastClosedVideoWindow(2'000'000, 2'100'000),
          "a future closed picture survived into an earlier AAC-window transaction");
}

void test_recorded_landing_splices_precede_cached_audio_init() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.beginMseRecordedSeek();
    remuxer.setOutputEnabled(false);
    remuxer.push(audio_unit(0));
    check(sink.events.empty(),
          "the output-disabled AAC probe emitted browser output");

    remuxer.setTimestampOffset(-534'666);
    check(sink.events.empty(),
          "arming a disabled Recorded landing emitted an early splice");
    remuxer.setOutputEnabled(true);
    check(sink.events == std::vector<std::string>{
              "video-splice", "audio-splice", "init:audio"},
          "the cached AAC init preceded the formal Recorded A/V splices");
    remuxer.cancelMseRecordedSeek();
}

} // namespace

int main() {
    test_previous_frame_fill_and_continuous_aac();
    test_stable_rap_fill_without_previous_frame();
    test_target_outside_damage_is_unchanged();
    test_closed_picture_repeats_over_audio_window();
    test_cra_picture_survives_reposition_for_exact_audio_window();
    test_closed_picture_is_cleared_before_a_new_audio_window_probe();
    test_recorded_landing_splices_precede_cached_audio_init();
    std::cout << "MSE Recorded frozen-window tests passed\n";
}
