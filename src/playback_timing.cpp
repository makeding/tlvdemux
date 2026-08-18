#include <tlvdemux/playback_timing.hpp>

#include <algorithm>

std::optional<tlvdemux::PlaybackTimingEvent>
tlvdemux::PlaybackTimingDiagnostics::observe_pts(
    const std::uint64_t track_id, const std::int64_t pts_us) noexcept {
    if (track_id_ != track_id) {
        track_id_ = track_id;
        last_pts_us_ = pts_us;
        return std::nullopt;
    }
    const auto previous = last_pts_us_.value_or(pts_us);
    last_pts_us_ = pts_us;
    const auto delta = pts_us - previous;
    if (delta > kPtsJumpThresholdUs) {
        return PlaybackTimingEvent{
            track_id, PlaybackTimingEventKind::PtsJump, pts_us, delta, kPrerollUs};
    }
    if (delta < 0) {
        return PlaybackTimingEvent{
            track_id, PlaybackTimingEventKind::PtsRegression, pts_us, delta, kPrerollUs};
    }
    return std::nullopt;
}

std::optional<tlvdemux::PlaybackTimingEvent>
tlvdemux::PlaybackTimingDiagnostics::observe_buffer(
    const std::uint64_t track_id, const std::int64_t playback_us,
    const std::int64_t buffered_until_us) noexcept {
    if (buffered_until_us >= playback_us) return std::nullopt;
    return PlaybackTimingEvent{
        track_id,
        PlaybackTimingEventKind::Underrun,
        playback_us,
        buffered_until_us - playback_us,
        std::max<std::int64_t>(kPrerollUs, playback_us - buffered_until_us),
    };
}

void tlvdemux::PlaybackTimingDiagnostics::reset() noexcept {
    track_id_.reset();
    last_pts_us_.reset();
}
