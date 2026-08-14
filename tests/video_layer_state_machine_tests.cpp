#include "mse/video_layer_state_machine.hpp"

#include <aribtlv/types.hpp>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>

namespace {

using tlvdemux::detail::mse::VideoLayerPair;
using tlvdemux::detail::mse::VideoLayerStateMachine;
using tlvdemux::detail::mse::VideoLayerSwitchRequest;

void check(const bool condition, const std::string& message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

aribtlv::AccessUnit video_unit(const std::uint64_t track_id,
                              const std::int64_t timestamp_us,
                              const bool random_access = false,
                              const bool discontinuity = false) {
    aribtlv::AccessUnit unit;
    unit.track_id = track_id;
    unit.codec = aribtlv::Codec::Hevc;
    unit.pts = {timestamp_us, 1000000};
    unit.dts = unit.pts;
    unit.random_access = random_access;
    unit.discontinuity = discontinuity;
    return unit;
}

void test_startup_breaks_do_not_trigger_fallback() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);

    for (std::int64_t timestamp = 0; timestamp <= 7000000; timestamp += 500000) {
        const bool startup_break = timestamp > 0 && timestamp <= 1500000;
        const auto fallback = machine.observe(video_unit(
            2, timestamp, timestamp % 1000000 == 0, false));
        const auto preferred = machine.observe(video_unit(
            1, timestamp, timestamp % 1000000 == 0, startup_break));
        check(!fallback && !preferred,
              "startup discontinuities triggered an automatic downgrade");
    }
}

void test_video_fallback_can_preserve_audio_track() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 11});
    machine.select(1);

    for (std::int64_t timestamp = 0; timestamp <= 8000000; timestamp += 500000) {
        machine.observe(video_unit(2, timestamp, timestamp % 1000000 == 0));
        machine.observe(video_unit(1, timestamp, timestamp % 1000000 == 0));
    }
    machine.observe(video_unit(2, 8500000, true));
    machine.observe(video_unit(1, 8500000, false, true));
    machine.observe(video_unit(2, 9000000, true));
    machine.observe(video_unit(1, 9000000, false, true));
    machine.observe(video_unit(2, 9400000, true));
    const auto fallback = machine.observe(video_unit(1, 9500000, false, true));
    check(fallback.has_value(), "video-only fallback was not requested");
    check(fallback->video_track_id == 2 && fallback->audio_track_id == 11,
          "video-only fallback did not preserve the selected audio track");
}

void test_degraded_preferred_layer_falls_back_and_recovers() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);

    for (std::int64_t timestamp = 0; timestamp <= 8000000; timestamp += 500000) {
        check(!machine.observe(video_unit(2, timestamp, timestamp % 1000000 == 0)),
              "healthy fallback unexpectedly requested a switch");
        check(!machine.observe(video_unit(1, timestamp, timestamp % 1000000 == 0)),
              "healthy preferred layer unexpectedly requested a switch");
    }

    check(!machine.observe(video_unit(2, 8500000)),
          "healthy fallback requested a switch");
    check(!machine.observe(video_unit(1, 8500000, false, true)),
          "one decode break triggered fallback");
    check(!machine.observe(video_unit(2, 9000000, true)),
          "healthy fallback requested a switch");
    check(!machine.observe(video_unit(1, 9000000, false, true)),
          "two decode breaks triggered fallback");
    check(!machine.observe(video_unit(2, 9400000, true)),
          "candidate observation triggered fallback before the threshold");
    const auto fallback = machine.observe(video_unit(1, 9500000, false, true));
    check(fallback.has_value(), "three nearby decode breaks did not trigger fallback");
    check(fallback->video_track_id == 2 && fallback->audio_track_id == 22,
          "fallback selected the wrong A/V pair");
    check(fallback->earliest_presentation_time_us == 6500000,
          "fallback did not request the configured preroll window");
    machine.switchCompleted(2);

    std::optional<VideoLayerSwitchRequest> recovery;
    for (std::int64_t timestamp = 10000000; timestamp <= 15000000;
         timestamp += 500000) {
        const auto preferred = machine.observe(video_unit(
            1, timestamp, timestamp % 1000000 == 0));
        if (preferred) recovery = preferred;
        const auto selected = machine.observe(video_unit(
            2, timestamp, timestamp % 1000000 == 0));
        if (selected) recovery = selected;
        if (timestamp < 14500000) {
            check(!recovery, "preferred layer recovered before five clean seconds");
        }
    }
    check(recovery.has_value(), "preferred layer did not recover after five clean seconds");
    check(recovery->video_track_id == 1 && recovery->audio_track_id == 11,
          "recovery selected the wrong A/V pair");
}

} // namespace

int main() {
    test_startup_breaks_do_not_trigger_fallback();
    test_video_fallback_can_preserve_audio_track();
    test_degraded_preferred_layer_falls_back_and_recovers();
    std::cout << "video layer state machine tests passed\n";
}
