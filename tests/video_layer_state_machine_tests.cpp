#include "mse/video_layer_state_machine.hpp"

#include <aribtlv/types.hpp>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using tlvdemux::PlaybackDamage;
using tlvdemux::PlaybackDamageSeverity;
using tlvdemux::PlaybackRecoveryAction;
using tlvdemux::detail::mse::VideoLayerPair;
using tlvdemux::detail::mse::VideoLayerStateMachine;
using tlvdemux::detail::mse::VideoLayerSwitchReason;

void check(const bool condition, const std::string& message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

aribtlv::AccessUnit unit(const std::uint64_t track_id,
                         const aribtlv::Codec codec,
                         const std::int64_t timestamp_us,
                         const bool random_access = false) {
    aribtlv::AccessUnit result;
    result.track_id = track_id;
    result.codec = codec;
    result.pts = {timestamp_us, 1000000};
    result.dts = result.pts;
    result.random_access = random_access;
    result.input_offset = static_cast<std::uint64_t>(timestamp_us + 100);
    result.restart_offset = static_cast<std::uint64_t>(timestamp_us + 50);
    return result;
}

PlaybackDamage damage(const std::uint64_t track_id,
                      const bool recovered = false) {
    return PlaybackDamage{
        track_id,
        5000000,
        5500000,
        recovered ? std::optional<std::int64_t>{8000000} : std::nullopt,
        100,
        200,
        recovered ? 300U : 0U,
        recovered ? 250U : 0U,
        PlaybackDamageSeverity::Severe,
        recovered ? PlaybackRecoveryAction::Seek
                  : PlaybackRecoveryAction::WaitForRecovery,
    };
}

void warm(VideoLayerStateMachine& machine, const bool preferred,
          const bool fallback, const std::int64_t from = 0,
          const std::int64_t through = 5000000) {
    for (std::int64_t timestamp = from; timestamp <= through; timestamp += 500000) {
        const bool rap = timestamp % 1000000 == 0;
        if (preferred) {
            machine.observe(unit(11, aribtlv::Codec::AacLatm, timestamp));
            machine.observe(unit(1, aribtlv::Codec::Hevc, timestamp, rap));
        }
        if (fallback) {
            machine.observe(unit(22, aribtlv::Codec::AacLatm, timestamp));
            machine.observe(unit(2, aribtlv::Codec::Hevc, timestamp, rap));
        }
    }
}

void test_preferred_damage_switches_without_seek_when_fallback_is_ready() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    // This is a decodable current-timeline entry, not a five-second health
    // baseline: emergency fallback must not wait for the recovery threshold.
    for (const auto timestamp : {5000000LL, 5500000LL}) {
        machine.observe(unit(11, aribtlv::Codec::AacLatm, timestamp));
        machine.observe(unit(1, aribtlv::Codec::Hevc, timestamp,
                             timestamp == 5000000));
        machine.observe(unit(22, aribtlv::Codec::AacLatm, timestamp));
        machine.observe(unit(2, aribtlv::Codec::Hevc, timestamp,
                             timestamp == 5000000));
    }

    const auto observation = machine.observeDamage(damage(1, true));
    check(observation.switch_request.has_value() &&
              observation.switch_request->video_track_id == 2 &&
              observation.switch_request->audio_track_id == 22,
          "healthy rainfall A/V did not accept preferred-layer damage");
    check(!observation.playback_damage.has_value(),
          "same-timeline rainfall switch leaked a competing seek");
}

void test_unavailable_fallback_waits_then_seeks_to_preferred_recovery_rap() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    warm(machine, true, false);

    const auto waiting = machine.observeDamage(damage(1));
    check(!waiting.switch_request.has_value() && waiting.playback_damage.has_value() &&
              waiting.playback_damage->action == PlaybackRecoveryAction::WaitForRecovery,
          "missing rainfall A/V did not publish wait-for-recovery");

    const auto recovery = machine.observe(unit(1, aribtlv::Codec::Hevc, 6000000, true));
    check(recovery.playback_damage.has_value() &&
              recovery.playback_damage->action == PlaybackRecoveryAction::Seek &&
              recovery.playback_damage->recovery_time_us ==
                  std::optional<std::int64_t>{6000000} &&
              recovery.playback_damage->recovery_input_offset == 6000100 &&
              recovery.playback_damage->recovery_restart_offset == 6000050,
          "preferred tracker did not seek at its first real recovery RAP");
}

void test_rainfall_mode_keeps_warming_preferred_and_returns_after_five_seconds() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    warm(machine, true, true);
    const auto fallback = machine.observeDamage(damage(1));
    check(fallback.switch_request.has_value(), "test could not enter rainfall mode");
    machine.switchCompleted(2);

    bool switched_back = false;
    for (std::int64_t timestamp = 6000000; timestamp <= 11000000;
         timestamp += 500000) {
        machine.setPlaybackPosition(timestamp);
        machine.observe(unit(11, aribtlv::Codec::AacLatm, timestamp));
        const auto preferred = machine.observe(unit(
            1, aribtlv::Codec::Hevc, timestamp, timestamp % 1000000 == 0));
        machine.observe(unit(22, aribtlv::Codec::AacLatm, timestamp));
        const auto rainfall = machine.observe(unit(
            2, aribtlv::Codec::Hevc, timestamp, timestamp % 1000000 == 0));
        const auto request = preferred.switch_request
            ? preferred.switch_request : rainfall.switch_request;
        if (request) {
            check(timestamp >= 11000000,
                  "preferred layer returned before five continuous seconds");
            check(request->video_track_id == 1 && request->audio_track_id == 11,
                  "rainfall recovery selected the wrong A/V pair");
            switched_back = true;
            break;
        }
    }
    check(switched_back, "rainfall mode did not keep warming the preferred tracker");
}

void test_manual_mode_keeps_health_observations_for_automatic_restore() {
    VideoLayerStateMachine machine;
    const VideoLayerPair pair{1, 11, 2, 22};
    machine.configure(pair);
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    warm(machine, true, true);
    machine.setPlaybackPosition(5000000);

    machine.suspend();
    machine.switchCompleted(2);
    check(!machine.reevaluate().switch_request,
          "suspended manual mode initiated an automatic layer switch");

    machine.configure(pair);
    const auto restored = machine.reevaluate();
    check(restored.switch_request.has_value() &&
              restored.switch_request->video_track_id == 1 &&
              restored.switch_request->audio_track_id == 11,
          "manual mode discarded preferred health needed when automatic mode resumed");
}

void test_parser_frontier_cannot_restore_preferred_at_stalled_playhead() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    warm(machine, true, true);
    check(machine.observeDamage(damage(1)).switch_request.has_value(),
          "test could not enter rainfall mode");
    machine.switchCompleted(2);
    machine.setPlaybackPosition(821944);

    for (std::int64_t timestamp = 6000000; timestamp <= 21000000;
         timestamp += 500000) {
        check(!machine.observe(
                  unit(11, aribtlv::Codec::AacLatm, timestamp)).switch_request,
              "preferred audio parser frontier restored a stalled playhead");
        check(!machine.observe(unit(
                  1, aribtlv::Codec::Hevc, timestamp,
                  timestamp % 1000000 == 0)).switch_request,
              "preferred video parser frontier restored a stalled playhead");
        machine.observe(unit(22, aribtlv::Codec::AacLatm, timestamp));
        check(!machine.observe(unit(
                  2, aribtlv::Codec::Hevc, timestamp,
                  timestamp % 1000000 == 0)).switch_request,
              "fallback parser frontier restored preferred at a stalled playhead");
    }
}

void test_rainfall_damage_uses_preferred_or_its_own_real_rap() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    warm(machine, true, true);
    machine.switchCompleted(2);

    const auto preferred = machine.observeDamage(damage(2));
    check(preferred.switch_request.has_value() &&
              preferred.switch_request->video_track_id == 1,
          "rainfall damage did not return directly to healthy preferred A/V");

    VideoLayerStateMachine isolated;
    isolated.configure(VideoLayerPair{1, 11, 2, 22});
    isolated.select(2);
    isolated.setSelectedOutputStarted(true);
    warm(isolated, false, true);
    const auto waiting = isolated.observeDamage(damage(2));
    check(!waiting.switch_request && waiting.playback_damage &&
              waiting.playback_damage->action == PlaybackRecoveryAction::WaitForRecovery,
          "unavailable preferred A/V invented a rainfall recovery target");
    const auto recovery = isolated.observe(
        unit(2, aribtlv::Codec::Hevc, 6500000, true));
    check(recovery.playback_damage &&
              recovery.playback_damage->recovery_time_us ==
                  std::optional<std::int64_t>{6500000},
          "rainfall tracker did not publish its own real recovery RAP");
}

void test_unstarted_preferred_switches_at_first_usable_rainfall_entry() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);

    check(!machine.observe(unit(2, aribtlv::Codec::Hevc, 821944, true)).switch_request,
          "a lone rainfall RAP triggered startup switching");
    check(!machine.observe(unit(22, aribtlv::Codec::AacLatm, 821944)).switch_request,
          "one rainfall AAC frame triggered startup switching");
    check(!machine.observe(unit(22, aribtlv::Codec::AacLatm, 843277)).switch_request,
          "rainfall audio without a following video DTS triggered startup switching");
    const auto ready = machine.observe(
        unit(2, aribtlv::Codec::Hevc, 855311, false));
    check(ready.switch_request.has_value() &&
              ready.switch_request->video_track_id == 2 &&
              ready.switch_request->audio_track_id == 22 &&
              ready.switch_request->earliest_presentation_time_us == 0 &&
              ready.switch_reason == VideoLayerSwitchReason::HealthDegradation,
          "unstarted preferred output did not request the earliest rainfall entry");
}

void test_unstarted_preferred_rejects_discontinuous_rainfall_or_missing_aac() {
    VideoLayerStateMachine discontinuous;
    discontinuous.configure(VideoLayerPair{1, 11, 2, 22});
    discontinuous.select(1);
    discontinuous.observe(unit(22, aribtlv::Codec::AacLatm, 821944));
    discontinuous.observe(unit(22, aribtlv::Codec::AacLatm, 843277));
    discontinuous.observe(unit(2, aribtlv::Codec::Hevc, 821944, true));
    auto broken = unit(2, aribtlv::Codec::Hevc, 855311);
    broken.dts = {821944, 1000000};
    check(!discontinuous.observe(broken).switch_request,
          "non-advancing rainfall DTS triggered startup switching");

    VideoLayerStateMachine no_audio;
    no_audio.configure(VideoLayerPair{1, 11, 2, 22});
    no_audio.select(1);
    no_audio.observe(unit(2, aribtlv::Codec::Hevc, 821944, true));
    check(!no_audio.observe(unit(2, aribtlv::Codec::Hevc, 855311)).switch_request,
          "rainfall video without AAC triggered startup switching");
}

void test_started_preferred_does_not_take_startup_fallback() {
    VideoLayerStateMachine machine;
    machine.configure(VideoLayerPair{1, 11, 2, 22});
    machine.select(1);
    machine.setSelectedOutputStarted(true);
    machine.observe(unit(22, aribtlv::Codec::AacLatm, 821944));
    machine.observe(unit(22, aribtlv::Codec::AacLatm, 843277));
    machine.observe(unit(2, aribtlv::Codec::Hevc, 821944, true));
    check(!machine.observe(unit(2, aribtlv::Codec::Hevc, 855311)).switch_request,
          "already-started preferred playback took the startup-only fallback path");
}

} // namespace

int main() {
    test_unstarted_preferred_switches_at_first_usable_rainfall_entry();
    test_unstarted_preferred_rejects_discontinuous_rainfall_or_missing_aac();
    test_started_preferred_does_not_take_startup_fallback();
    test_preferred_damage_switches_without_seek_when_fallback_is_ready();
    test_unavailable_fallback_waits_then_seeks_to_preferred_recovery_rap();
    test_rainfall_mode_keeps_warming_preferred_and_returns_after_five_seconds();
    test_manual_mode_keeps_health_observations_for_automatic_restore();
    test_parser_frontier_cannot_restore_preferred_at_stalled_playhead();
    test_rainfall_damage_uses_preferred_or_its_own_real_rap();
    std::cout << "video layer state machine tests passed\n";
}
