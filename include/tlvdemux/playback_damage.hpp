#pragma once

#include <aribtlv/types.hpp>

#include <cstdint>
#include <optional>

namespace tlvdemux {

enum class PlaybackDamageSeverity {
    Warning,
    Severe,
};

enum class PlaybackRecoveryAction {
    None,
    Seek,
    WaitForRecovery,
};

struct PlaybackDamage {
    std::uint64_t video_track_id = 0;
    std::optional<std::int64_t> start_time_us;
    std::int64_t end_time_us = 0;
    std::optional<std::int64_t> recovery_time_us;
    std::uint64_t start_input_offset = 0;
    std::uint64_t end_input_offset = 0;
    std::uint64_t recovery_input_offset = 0;
    std::uint64_t recovery_restart_offset = 0;
    PlaybackDamageSeverity severity = PlaybackDamageSeverity::Warning;
    PlaybackRecoveryAction action = PlaybackRecoveryAction::None;
};

class PlaybackDamageAdvisor {
public:
    static constexpr std::int64_t kSevereDurationUs = 2'000'000;

    void selectVideoTrack(std::optional<std::uint64_t> track_id) noexcept;
    std::optional<PlaybackDamage> observe(const aribtlv::DamageSpan& damage) const;

private:
    std::optional<std::uint64_t> selected_video_track_;
};

} // namespace tlvdemux
