#pragma once

#include <cstdint>
#include <optional>

namespace tlvdemux {

enum class PlaybackTimingEventKind : std::uint8_t {
    PtsJump,
    PtsRegression,
    Underrun,
};

struct PlaybackTimingEvent {
    std::uint64_t track_id = 0;
    PlaybackTimingEventKind kind = PlaybackTimingEventKind::PtsJump;
    std::int64_t timestamp_us = 0;
    std::int64_t delta_us = 0;
    std::int64_t recommended_preroll_us = 0;
    bool operator==(const PlaybackTimingEvent&) const = default;
};

class PlaybackTimingDiagnostics {
public:
    static constexpr std::int64_t kPtsJumpThresholdUs = 500'000;
    static constexpr std::int64_t kPrerollUs = 250'000;

    std::optional<PlaybackTimingEvent> observe_pts(
        std::uint64_t track_id, std::int64_t pts_us) noexcept;
    std::optional<PlaybackTimingEvent> observe_buffer(
        std::uint64_t track_id, std::int64_t playback_us,
        std::int64_t buffered_until_us) noexcept;
    void reset() noexcept;

private:
    std::optional<std::uint64_t> track_id_;
    std::optional<std::int64_t> last_pts_us_;
};

} // namespace tlvdemux
