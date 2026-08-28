#include <tlvdemux/playback_damage.hpp>

#include <cstdlib>
#include <iostream>
#include <optional>

namespace {

[[noreturn]] void fail(const char* message) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void check(const bool condition, const char* message) {
    if (!condition) fail(message);
}

aribtlv::DamageSpan video_damage(const std::uint64_t track_id,
                                 const std::int64_t start_us,
                                 const std::int64_t end_us,
                                 const bool recovered = true,
                                 const bool recovery_random_access = true) {
    return aribtlv::DamageSpan{
        track_id,
        aribtlv::TrackKind::Video,
        aribtlv::Codec::Hevc,
        aribtlv::Timestamp{start_us, 1'000'000},
        aribtlv::Timestamp{end_us, 1'000'000},
        recovered
            ? std::optional<aribtlv::Timestamp>{
                  aribtlv::Timestamp{end_us, 1'000'000}}
            : std::nullopt,
        100,
        200,
        recovered ? 200U : 0U,
        recovered ? 80U : 0U,
        aribtlv::DiscontinuityReason::SourceDamage,
        recovered && recovery_random_access,
        recovered,
    };
}

} // namespace

int main() {
    tlvdemux::PlaybackDamageAdvisor advisor;
    advisor.selectVideoTrack(10);

    check(!advisor.observe(video_damage(11, 0, 30'000'000)).has_value(),
          "damage from an unselected layer was reported");

    const auto warning = advisor.observe(video_damage(10, 1'000'000, 2'000'000));
    check(warning.has_value() &&
              warning->severity == tlvdemux::PlaybackDamageSeverity::Warning &&
              warning->action == tlvdemux::PlaybackRecoveryAction::SeekIfStalled &&
              warning->start_time_us == std::optional<std::int64_t>{1'000'000} &&
              warning->recovery_time_us == std::optional<std::int64_t>{2'000'000} &&
              warning->start_input_offset == 100 &&
              warning->end_input_offset == 200 &&
              warning->recovery_input_offset == 200 &&
              warning->recovery_restart_offset == 80,
          "short recovered damage did not arm stall-only recovery at its real RAP");

    const auto severe = advisor.observe(video_damage(10, 3'000'000, 30'500'000));
    check(severe.has_value() &&
              severe->severity == tlvdemux::PlaybackDamageSeverity::Severe &&
              severe->action == tlvdemux::PlaybackRecoveryAction::Seek &&
              severe->recovery_time_us == std::optional<std::int64_t>{30'500'000},
          "long recovered damage did not recommend seeking to its recovery point");

    const auto incomplete = advisor.observe(video_damage(10, 31'000'000, 32'000'000, false));
    check(incomplete.has_value() &&
              incomplete->severity == tlvdemux::PlaybackDamageSeverity::Severe &&
              incomplete->action == tlvdemux::PlaybackRecoveryAction::WaitForRecovery &&
              !incomplete->recovery_time_us.has_value(),
          "unrecovered damage did not report that playback must wait");

    const auto no_rap = advisor.observe(
        video_damage(10, 33'000'000, 34'000'000, true, false));
    check(no_rap.has_value() &&
              no_rap->severity == tlvdemux::PlaybackDamageSeverity::Severe &&
              no_rap->action == tlvdemux::PlaybackRecoveryAction::WaitForRecovery &&
              !no_rap->recovery_time_us.has_value(),
          "damage without a real recovery RAP authorized a seek");
}
