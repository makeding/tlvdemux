#include <tlvdemux/playback_damage.hpp>

#include <cmath>
#include <limits>

namespace {

std::optional<std::int64_t> microseconds(const aribtlv::Timestamp timestamp) {
    if (timestamp.timescale == 0) return std::nullopt;
    const long double value = static_cast<long double>(timestamp.value) * 1'000'000.0L /
        static_cast<long double>(timestamp.timescale);
    if (!std::isfinite(value) ||
        value < static_cast<long double>(std::numeric_limits<std::int64_t>::min()) ||
        value > static_cast<long double>(std::numeric_limits<std::int64_t>::max())) {
        return std::nullopt;
    }
    return static_cast<std::int64_t>(value);
}

} // namespace

void tlvdemux::PlaybackDamageAdvisor::selectVideoTrack(
    const std::optional<std::uint64_t> track_id) noexcept {
    selected_video_track_ = track_id;
}

std::optional<tlvdemux::PlaybackDamage>
tlvdemux::PlaybackDamageAdvisor::observe(const aribtlv::DamageSpan& damage) const {
    if (damage.kind != aribtlv::TrackKind::Video ||
        !selected_video_track_.has_value() ||
        damage.track_id != *selected_video_track_ ||
        !aribtlv::hasDiscontinuityReason(
            damage.reasons, aribtlv::DiscontinuityReason::SourceDamage)) {
        return std::nullopt;
    }

    const auto start = damage.start_time.has_value()
        ? microseconds(*damage.start_time)
        : std::nullopt;
    const auto end = microseconds(damage.end_time);
    const auto recovery = damage.recovered && damage.recovery_random_access &&
        damage.recovery_time.has_value()
        ? microseconds(*damage.recovery_time)
        : std::nullopt;
    if (!end.has_value() ||
        (damage.recovered && damage.recovery_random_access &&
         damage.recovery_time.has_value() && !recovery.has_value())) {
        return std::nullopt;
    }

    const auto interval_start = start.value_or(*end);
    const auto interval_end = recovery.value_or(*end);
    const auto duration = interval_end >= interval_start
        ? interval_end - interval_start
        : std::int64_t{0};
    const bool severe = !recovery.has_value() || duration >= kSevereDurationUs;
    const auto action = recovery.has_value()
        ? (severe ? PlaybackRecoveryAction::Seek
                  : PlaybackRecoveryAction::SeekIfStalled)
        : PlaybackRecoveryAction::WaitForRecovery;

    return PlaybackDamage{
        damage.track_id,
        start,
        *end,
        recovery,
        damage.start_input_offset,
        damage.end_input_offset,
        damage.recovery_input_offset,
        damage.recovery_restart_offset,
        severe ? PlaybackDamageSeverity::Severe : PlaybackDamageSeverity::Warning,
        action,
    };
}
