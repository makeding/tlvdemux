#include <tlvdemux/mse_remuxer.hpp>

#include "mse_remuxer_test_media.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
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
        inits.push_back(std::move(init));
    }
    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        segments.push_back(std::move(segment));
    }
    void onMseLayerSwitchStarted(
        const tlvdemux::MseLayerSwitchStarted& started) override {
        starts.push_back(started);
    }
    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        switches.push_back(layer);
    }
    void onMseLayerSwitchCancelled(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) override {
        cancellations.push_back(cancelled);
    }
    void onPlaybackDamage(const tlvdemux::PlaybackDamage& damage) override {
        playback_damage.push_back(damage);
    }

    std::vector<tlvdemux::MseTrackInit> inits;
    std::vector<tlvdemux::MseMediaSegment> segments;
    std::vector<tlvdemux::MseLayerSwitchStarted> starts;
    std::vector<tlvdemux::MseLayerSwitch> switches;
    std::vector<tlvdemux::MseLayerSwitchCancelled> cancellations;
    std::vector<tlvdemux::PlaybackDamage> playback_damage;
};

std::vector<std::uint8_t> loas_frame() {
    BitWriter writer;
    writer.bits(0, 1);  // useSameStreamMux
    writer.bits(0, 1);  // audioMuxVersion
    writer.bits(1, 1);  // allStreamsSameTimeFraming
    writer.bits(0, 6);  // numSubFrames
    writer.bits(0, 4);  // numProgram
    writer.bits(0, 3);  // numLayer
    writer.bits(2, 5);  // AAC LC
    writer.bits(3, 4);  // 48000 Hz
    writer.bits(2, 4);  // stereo
    writer.bits(0, 1);  // frameLengthFlag
    writer.bits(0, 1);  // dependsOnCoreCoder
    writer.bits(0, 1);  // extensionFlag
    writer.bits(0, 3);  // frameLengthType
    writer.bits(0, 8);  // latmBufferFullness
    writer.bits(0, 1);  // otherDataPresent
    writer.bits(0, 1);  // crcCheckPresent
    writer.bits(1, 8);  // payloadLengthInfo
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

tlvdemux::AccessUnit aac_unit(const std::uint64_t track_id,
                              const std::int64_t pts_value) {
    tlvdemux::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = tlvdemux::Codec::AacLatm;
    unit.data = loas_frame();
    unit.pts = {pts_value, 48000};
    unit.dts = unit.pts;
    return unit;
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

void warm_automatic_layer_pair(tlvdemux::MseRemuxer& remuxer) {
    for (std::int64_t index = 0; index < 300; ++index) {
        remuxer.push(aac_unit(1, index * 1024));
        remuxer.push(aac_unit(9, index * 1024));
    }
    for (std::int64_t timestamp = 0; timestamp <= 5000000;
         timestamp += 500000) {
        const bool rap = timestamp % 1000000 == 0;
        remuxer.push(hevc_unit(2, timestamp, timestamp, rap, timestamp == 0));
        remuxer.push(hevc_unit(3, timestamp, timestamp, rap, timestamp == 0));
    }
}

void test_repeated_selection_acknowledgement_is_idempotent() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.push(hevc_unit(2, 0, 0, true, true));
    remuxer.push(hevc_unit(2, 33'367, 33'367, false, false));

    check(!remuxer.selectTrack(tlvdemux::TrackKind::Video, 2).has_value(),
          "same-video acknowledgement reported a layer cancellation");
    check(!remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1).has_value(),
          "same-audio acknowledgement reported a layer cancellation");
    remuxer.push(hevc_unit(2, 66'734, 66'734, false, false));
    remuxer.flush();

    const auto video_inits = std::count_if(
        sink.inits.begin(), sink.inits.end(),
        [](const auto& init) { return init.type == "video"; });
    const auto complete_video = std::any_of(
        sink.segments.begin(), sink.segments.end(), [](const auto& segment) {
            return segment.type == "video" && segment.end_time_us >= 100'101;
        });
    check(video_inits == 1 && complete_video,
          "same-track acknowledgement reset the recorded-seek landing muxer");
}

void test_fence_defers_damage_until_exact_commit() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    warm_automatic_layer_pair(remuxer);

    remuxer.beginMseRecordedSeek();
    check(!remuxer.observeDamage(severe_source_damage(2)).has_value() &&
              sink.starts.empty() && sink.switches.empty() && sink.playback_damage.empty(),
          "recorded-seek fence leaked an automatic switch or recovery decision");
    remuxer.finishMseRecordedSeek(5'000'000);
    check(sink.starts.size() == 1 &&
              sink.starts.front().reason == tlvdemux::MseLayerSwitchReason::SourceDamage &&
              sink.starts.front().earliest_presentation_time_us > 0,
          "exact seek commit did not perform one target-clock reevaluation");

    const auto completed_before_replacement = sink.switches.size();
    remuxer.beginMseRecordedSeek();
    check(completed_before_replacement > 0 ||
              (sink.cancellations.size() == 1 &&
               sink.cancellations.front().reason ==
                   tlvdemux::MseLayerSwitchCancelReason::Reposition),
          "replacement seek neither observed nor cancelled the reevaluated switch");
    remuxer.reposition();
    remuxer.cancelMseRecordedSeek();
    check(sink.starts.size() == 1 && sink.switches.size() == completed_before_replacement,
          "cancelled recorded seek committed a stale automatic decision");
}

void test_cancel_does_not_commit_startup_fallback() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    remuxer.beginMseRecordedSeek();
    for (std::int64_t index = 0; index < 120; ++index) {
        remuxer.push(aac_unit(9, index * 1024));
    }
    remuxer.push(hevc_unit(3, 100000, 100000, true, true));
    remuxer.push(hevc_unit(3, 133367, 133367, false, false));
    check(sink.starts.empty(), "startup fallback started inside the seek fence");
    remuxer.cancelMseRecordedSeek();
    remuxer.push(hevc_unit(2, 166733, 166733, false, false));
    check(sink.starts.empty(),
          "cancelled seek replayed a cached startup fallback on later input");
}

void test_cancel_discards_deferred_damage_decision() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    warm_automatic_layer_pair(remuxer);

    remuxer.beginMseRecordedSeek();
    remuxer.observeDamage(severe_source_damage(2));
    remuxer.cancelMseRecordedSeek();
    remuxer.push(aac_unit(1, 300 * 1024));
    remuxer.push(hevc_unit(2, 5'500'000, 5'500'000, false, false));
    check(sink.starts.empty() && sink.playback_damage.empty(),
          "cancelled seek replayed its deferred damage decision");
}

void test_replacement_begin_discards_previous_seek_decision() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.configureAutomaticLayerSwitch({2, 1, 3, 9});
    warm_automatic_layer_pair(remuxer);

    remuxer.beginMseRecordedSeek();
    remuxer.observeDamage(severe_source_damage(2));
    remuxer.beginMseRecordedSeek();
    remuxer.finishMseRecordedSeek(7'000'000);
    check(sink.starts.empty() && sink.playback_damage.empty(),
          "replacement begin committed the previous seek decision");
}

} // namespace

int main() {
    test_repeated_selection_acknowledgement_is_idempotent();
    test_fence_defers_damage_until_exact_commit();
    test_cancel_does_not_commit_startup_fallback();
    test_cancel_discards_deferred_damage_decision();
    test_replacement_begin_discards_previous_seek_decision();
    std::cout << "MSE recorded-seek fence tests passed\n";
}
