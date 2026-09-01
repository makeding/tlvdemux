#include <tlvdemux/mse_remuxer.hpp>
#include "mse_remuxer_test_media.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
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
    void onMseInit(tlvdemux::MseTrackInit&&) override {}
    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        segments.push_back(std::move(segment));
    }
    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        video_splices.push_back(splice);
    }
    void onMseVideoRecovery(
        const tlvdemux::MseVideoRecoveryEvent& event) override {
        recovery.push_back(event);
    }
    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        layer_switches.push_back(layer);
    }
    void onMseLayerSwitchStarted(
        const tlvdemux::MseLayerSwitchStarted& layer) override {
        layer_switch_starts.push_back(layer);
    }

    std::vector<tlvdemux::MseMediaSegment> segments;
    std::vector<tlvdemux::MseVideoSplice> video_splices;
    std::vector<tlvdemux::MseVideoRecoveryEvent> recovery;
    std::vector<tlvdemux::MseLayerSwitch> layer_switches;
    std::vector<tlvdemux::MseLayerSwitchStarted> layer_switch_starts;
};

std::vector<std::uint8_t> loas_frame() {
    BitWriter writer;
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(1, 1);
    writer.bits(0, 6);
    writer.bits(0, 4);
    writer.bits(0, 3);
    writer.bits(2, 5);
    writer.bits(3, 4);
    writer.bits(2, 4);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(0, 3);
    writer.bits(0, 8);
    writer.bits(0, 1);
    writer.bits(0, 1);
    writer.bits(1, 8);
    writer.bits(0xaa, 8);
    auto payload = writer.take();
    const auto size = static_cast<std::uint16_t>(payload.size());
    std::vector<std::uint8_t> frame{
        0x56, static_cast<std::uint8_t>(0xe0 | (size >> 8)),
        static_cast<std::uint8_t>(size)};
    frame.insert(frame.end(), payload.begin(), payload.end());
    return frame;
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

tlvdemux::AccessUnit audio_unit_for(
    const std::uint64_t track_id, const std::int64_t pts) {
    auto unit = audio_unit(pts);
    unit.track_id = track_id;
    return unit;
}

tlvdemux::AccessUnit damaged(tlvdemux::AccessUnit unit) {
    unit.discontinuity = true;
    unit.discontinuity_reasons = aribtlv::DiscontinuityReason::SourceDamage;
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

void enable_recorded_continuity(tlvdemux::MseRemuxer& remuxer) {
    remuxer.beginMseRecordedSeek();
    remuxer.finishMseRecordedSeek(0);
}

std::vector<tlvdemux::MseMediaSegment> media_of(
    const std::vector<tlvdemux::MseMediaSegment>& segments,
    const std::string& type) {
    std::vector<tlvdemux::MseMediaSegment> result;
    for (const auto& segment : segments) {
        if (segment.type == type) result.push_back(segment);
    }
    std::sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
        return left.start_time_us < right.start_time_us;
    });
    return result;
}

void assert_contiguous(const std::vector<tlvdemux::MseMediaSegment>& segments,
                       const std::int64_t tolerance_us,
                       const std::string& label) {
    check(!segments.empty(), label + " emitted no segments");
    auto end = segments.front().end_time_us;
    for (std::size_t index = 1; index < segments.size(); ++index) {
        check(segments[index].start_time_us <= end + tolerance_us,
              label + " contains a coded coverage gap");
        end = std::max(end, segments[index].end_time_us);
    }
}

void test_no_fallback_or_later_rap_freezes_through_aac_eos() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    enable_recorded_continuity(remuxer);

    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(hevc_unit(2, 33'367, 33'367, false, false));
    remuxer.push(audio_unit(0));
    remuxer.push(audio_unit(1024));
    remuxer.push(damaged(hevc_unit(2, 100'000, 100'000, false, false)));
    remuxer.observeDamage(damage_span(100'000, 120'000));
    for (std::int64_t pts = 2048; pts <= 144000; pts += 1024) {
        remuxer.push(audio_unit(pts));
    }
    remuxer.endOfStream();

    const auto video = media_of(sink.segments, "video");
    const auto audio = media_of(sink.segments, "audio");
    assert_contiguous(video, 34'000, "frozen video");
    assert_contiguous(audio, 10, "selected AAC");
    check(video.back().end_time_us + 34'000 >= audio.back().end_time_us,
          "frozen video stopped before selected AAC EOS");
    check(std::any_of(video.begin(), video.end(), [](const auto& segment) {
              return segment.end_time_us - segment.start_time_us >= 200'000;
          }), "frozen pictures were emitted as per-frame tiny fragments");
    check(!sink.recovery.empty() &&
              sink.recovery.front().continuity_state == "frozen" &&
              sink.recovery.front().damage_start_us.has_value(),
          "recovery diagnostics did not expose the frozen damage boundary");
}

void test_damaged_candidates_freeze_until_stable_rap_splice() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    enable_recorded_continuity(remuxer);

    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(hevc_unit(2, 33'367, 33'367, false, false));
    remuxer.push(damaged(hevc_unit(2, 100'000, 100'000, false, false)));
    remuxer.observeDamage(damage_span(100'000, 500'000));
    remuxer.push(hevc_unit(2, 500'000, 500'000, true, false));
    remuxer.push(hevc_unit(2, 533'367, 533'367, false, false));
    remuxer.push(damaged(hevc_unit(2, 800'000, 800'000, true, false)));
    remuxer.observeDamage(damage_span(800'000, 1'100'000));
    for (std::int64_t pts = 0; pts <= 48000; pts += 1024) {
        remuxer.push(audio_unit(pts));
    }
    remuxer.push(hevc_unit(2, 1'100'000, 1'100'000, true, false));
    remuxer.push(hevc_unit(2, 1'133'367, 1'133'367, false, false));
    for (std::int64_t pts = 49152; pts <= 72000; pts += 1024) {
        remuxer.push(audio_unit(pts));
    }
    remuxer.push(hevc_unit(2, 1'600'000, 1'600'000, true, false));
    remuxer.push(hevc_unit(2, 1'633'367, 1'633'367, false, false));
    remuxer.endOfStream();

    check(sink.recovery.size() == 3 &&
              sink.recovery[1].phase ==
                  tlvdemux::MseVideoRecoveryPhase::CandidateRejected &&
              sink.recovery[2].phase ==
                  tlvdemux::MseVideoRecoveryPhase::StableRapCommitted,
          "repeated candidate damage lost the three recovery transitions");
    check(!sink.video_splices.empty(),
          "stable preferred RAP did not perform a video-only splice");
    const auto audio = media_of(sink.segments, "audio");
    assert_contiguous(audio, 10, "selected AAC during preferred restoration");
}

void test_rainfall_is_video_only_until_stable_preferred_rap() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    enable_recorded_continuity(remuxer);

    for (std::int64_t pts = 0; pts <= 24'576; pts += 1024) {
        remuxer.push(audio_unit_for(1, pts));
        remuxer.push(audio_unit_for(9, pts));
    }
    for (std::int64_t pts = 0; pts <= 500'000; pts += 33'367) {
        remuxer.push(hevc_unit(2, pts, pts, pts == 0, pts == 0));
    }
    for (std::int64_t pts = 0; pts <= 500'000; pts += 33'367) {
        const bool rap = pts == 0 || (pts >= 300'000 && pts < 334'000);
        remuxer.push(hevc_unit(3, pts, pts, rap, pts == 0));
    }
    remuxer.push(damaged(hevc_unit(2, 600'000, 600'000, false, false)));
    auto rainfall_damage = damage_span(600'000, 650'000);
    rainfall_damage.recovery_time.reset();
    rainfall_damage.recovered = false;
    rainfall_damage.recovery_random_access = false;
    remuxer.observeDamage(rainfall_damage);

    for (std::int64_t pts = 650'000; pts <= 1'650'000; pts += 33'367) {
        remuxer.push(hevc_unit(3, pts, pts, pts == 650'000, false));
    }
    check(sink.layer_switches.size() == 1 &&
              sink.layer_switches.front().video_track_id == 3 &&
              sink.layer_switches.front().audio_track_id == 1,
          "rainfall recovery did not commit one video-only switch: count=" +
              std::to_string(sink.layer_switches.size()) +
              " starts=" + std::to_string(sink.layer_switch_starts.size()) +
              (sink.layer_switch_starts.empty() ? std::string{} :
                  " start-video=" + std::to_string(
                      sink.layer_switch_starts.front().video_track_id) +
                  " start-audio=" + std::to_string(
                      sink.layer_switch_starts.front().audio_track_id) +
                  " start-at=" + std::to_string(
                      sink.layer_switch_starts.front().earliest_presentation_time_us)) +
              (sink.layer_switches.empty() ? std::string{} :
                  " video=" + std::to_string(
                      sink.layer_switches.front().video_track_id) +
                  " audio=" + std::to_string(
                      sink.layer_switches.front().audio_track_id)));

    remuxer.push(hevc_unit(2, 1'700'000, 1'700'000, true, false));
    remuxer.push(hevc_unit(2, 1'733'367, 1'733'367, false, false));
    remuxer.push(damaged(hevc_unit(2, 1'900'000, 1'900'000, true, false)));
    remuxer.push(hevc_unit(2, 2'100'000, 2'100'000, true, false));
    remuxer.push(hevc_unit(2, 2'133'367, 2'133'367, false, false));
    remuxer.push(hevc_unit(2, 2'500'000, 2'500'000, true, false));
    for (std::int64_t pts = 2'533'367; pts <= 4'000'000; pts += 33'367) {
        remuxer.push(hevc_unit(2, pts, pts, false, false));
    }
    for (std::int64_t pts = 25'600; pts <= 96'000; pts += 1024) {
        remuxer.push(audio_unit_for(1, pts));
        remuxer.push(audio_unit_for(9, pts));
    }
    remuxer.endOfStream();

    check(sink.layer_switches.size() == 2 &&
              sink.layer_switches.back().video_track_id == 2 &&
              sink.layer_switches.back().audio_track_id == 1,
          "stable preferred recovery was not a video-only splice: count=" +
              std::to_string(sink.layer_switches.size()) +
              (sink.layer_switches.empty() ? std::string{} :
                  " last-video=" + std::to_string(
                      sink.layer_switches.back().video_track_id) +
                  " last-audio=" + std::to_string(
                      sink.layer_switches.back().audio_track_id)) +
              " starts=" + std::to_string(sink.layer_switch_starts.size()) +
              (sink.layer_switch_starts.empty() ? std::string{} :
                  " last-start-video=" + std::to_string(
                      sink.layer_switch_starts.back().video_track_id) +
                  " last-start-audio=" + std::to_string(
                      sink.layer_switch_starts.back().audio_track_id) +
                  " last-start-at=" + std::to_string(
                      sink.layer_switch_starts.back().earliest_presentation_time_us)));
    check(std::any_of(sink.recovery.begin(), sink.recovery.end(), [](const auto& event) {
              return event.phase ==
                  tlvdemux::MseVideoRecoveryPhase::CandidateRejected;
          }), "damaged preferred candidate was not rejected");
    check(std::any_of(sink.recovery.begin(), sink.recovery.end(), [](const auto& event) {
              return event.phase ==
                  tlvdemux::MseVideoRecoveryPhase::StableRapCommitted;
          }), "stable preferred RAP was not committed");
    assert_contiguous(media_of(sink.segments, "audio"), 10,
                      "selected AAC across rainfall recovery");
}

} // namespace

int main() {
    test_no_fallback_or_later_rap_freezes_through_aac_eos();
    test_damaged_candidates_freeze_until_stable_rap_splice();
    test_rainfall_is_video_only_until_stable_preferred_rap();
    std::cout << "MSE Recorded continuity tests passed\n";
}
