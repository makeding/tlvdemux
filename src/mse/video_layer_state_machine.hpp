#pragma once

#include <aribtlv/types.hpp>

#include <cstdint>
#include <map>
#include <optional>

namespace tlvdemux::detail::mse {

struct VideoLayerPair {
    std::uint64_t preferred_video_id = 0;
    std::uint64_t preferred_audio_id = 0;
    std::uint64_t fallback_video_id = 0;
    std::uint64_t fallback_audio_id = 0;
};

struct VideoLayerSwitchRequest {
    std::uint64_t video_track_id = 0;
    std::uint64_t audio_track_id = 0;
    std::int64_t earliest_presentation_time_us = 0;
};

class VideoLayerStateMachine {
public:
    void configure(VideoLayerPair pair);
    void clearConfiguration() noexcept;
    void select(std::optional<std::uint64_t> video_track_id) noexcept;
    void switchStarted(std::uint64_t video_track_id) noexcept;
    void resetObservations() noexcept;
    void switchCompleted(std::uint64_t video_track_id) noexcept;
    void switchCancelled(std::uint64_t previous_video_track_id) noexcept;
    std::optional<VideoLayerSwitchRequest> observe(const aribtlv::AccessUnit& unit);

private:
    struct TrackState {
        std::optional<std::int64_t> last_dts_us;
        std::optional<std::int64_t> last_pts_us;
        std::optional<std::int64_t> last_rap_pts_us;
        std::optional<std::int64_t> clean_since_dts_us;
        std::optional<std::int64_t> last_break_dts_us;
        unsigned recent_breaks = 0;
        bool baseline_established = false;
        bool healthy = false;
    };

    static void update(TrackState& state, const aribtlv::AccessUnit& unit);
    std::optional<VideoLayerSwitchRequest> decide();

    std::map<std::uint64_t, TrackState> tracks_;
    std::optional<VideoLayerPair> pair_;
    std::optional<std::uint64_t> selected_video_id_;
    std::optional<std::uint64_t> pending_video_id_;
};

} // namespace tlvdemux::detail::mse
