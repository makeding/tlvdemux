#pragma once

#include <aribtlv/types.hpp>
#include <tlvdemux/playback_damage.hpp>

#include <cstdint>
#include <deque>
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

enum class VideoLayerSwitchReason {
    HealthDegradation,
    SourceDamage,
};

struct VideoLayerObservation {
    std::optional<VideoLayerSwitchRequest> switch_request;
    std::optional<PlaybackDamage> playback_damage;
    VideoLayerSwitchReason switch_reason = VideoLayerSwitchReason::HealthDegradation;
};

class VideoLayerStateMachine {
public:
    void configure(VideoLayerPair pair);
    void clearConfiguration() noexcept;
    void select(std::optional<std::uint64_t> video_track_id) noexcept;
    void resetObservations() noexcept;
    void clearUnrecoveredDamage() noexcept;
    void switchCompleted(std::uint64_t video_track_id) noexcept;
    void setSelectedOutputStarted(bool started) noexcept;
    void setPlaybackPosition(std::int64_t presentation_time_us) noexcept;
    VideoLayerObservation observe(const aribtlv::AccessUnit& unit);
    VideoLayerObservation observeDamage(const PlaybackDamage& damage);

private:
    struct Continuity {
        std::optional<std::int64_t> last_dts_us;
        std::optional<std::int64_t> last_pts_us;
        std::optional<std::int64_t> clean_since_dts_us;
        bool baseline_established = false;
        bool healthy = false;
    };

    struct Rap {
        std::int64_t pts_us = 0;
        std::int64_t dts_us = 0;
        std::uint64_t input_offset = 0;
        std::uint64_t restart_offset = 0;
    };

    struct LayerTracker {
        Continuity video;
        Continuity audio;
        std::optional<Rap> last_rap;
        std::deque<Rap> recent_raps;
        std::optional<std::int64_t> last_break_dts_us;
        unsigned recent_breaks = 0;
        std::optional<PlaybackDamage> unrecovered_damage;
        std::deque<std::int64_t> recent_audio_pts_us;
    };

    static bool updateContinuity(Continuity& state,
                                 const aribtlv::AccessUnit& unit);
    static void updateVideo(LayerTracker& tracker,
                            const aribtlv::AccessUnit& unit);
    static void updateAudio(LayerTracker& tracker,
                            const aribtlv::AccessUnit& unit);
    static bool usableAt(const LayerTracker& tracker,
                         std::int64_t presentation_time_us,
                         bool require_healthy_baseline);
    static bool usableForStartup(const LayerTracker& tracker);
    static void markDamaged(LayerTracker& tracker,
                            std::int64_t end_time_us);

    LayerTracker* layerForVideo(std::uint64_t track_id) noexcept;
    const LayerTracker* layerForVideo(std::uint64_t track_id) const noexcept;
    LayerTracker* activeLayer() noexcept;
    const LayerTracker* activeLayer() const noexcept;
    LayerTracker* otherLayer() noexcept;
    const LayerTracker* otherLayer() const noexcept;
    std::optional<VideoLayerSwitchRequest> requestOtherLayer(
        bool require_healthy_baseline) const;
    std::optional<VideoLayerSwitchRequest> requestStartupFallback() const;
    VideoLayerObservation decide() const;

    std::optional<VideoLayerPair> pair_;
    std::optional<std::uint64_t> selected_video_id_;
    std::optional<std::int64_t> playback_position_us_;
    bool selected_output_started_ = false;
    LayerTracker preferred_;
    LayerTracker fallback_;
};

} // namespace tlvdemux::detail::mse
