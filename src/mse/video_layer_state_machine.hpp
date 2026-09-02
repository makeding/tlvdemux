#pragma once

#include <aribtlv/types.hpp>
#include <tlvdemux/playback_damage.hpp>
#include <tlvdemux/mse_remuxer.hpp>

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
    std::optional<MseAvRecoveryEvidence> recovery_evidence;
    MseAvRecoveryState state = MseAvRecoveryState::Starting;
};

class VideoLayerStateMachine {
public:
    void configure(VideoLayerPair pair);
    void suspend() noexcept;
    void resume() noexcept;
    void clearConfiguration() noexcept;
    void select(std::optional<std::uint64_t> video_track_id) noexcept;
    void resetObservations() noexcept;
    void clearUnrecoveredDamage() noexcept;
    void discardDeferredDecision() noexcept;
    void switchCompleted(std::uint64_t video_track_id) noexcept;
    void setSelectedOutputStarted(bool started) noexcept;
    void setPlaybackPosition(std::int64_t presentation_time_us) noexcept;
    void setGeneration(std::uint64_t generation) noexcept;
    MseAvRecoveryState state() const noexcept { return state_; }
    VideoLayerObservation observe(const aribtlv::AccessUnit& unit);
    VideoLayerObservation observeDamage(const PlaybackDamage& damage);
    VideoLayerObservation reevaluate() const;

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
        std::optional<Rap> recovery_rap;
        std::uint64_t recovery_episode_id = 0;
        std::uint64_t recovery_generation = 0;
        MseAvRecoveryState recovery_origin_state = MseAvRecoveryState::Starting;
    };

    static bool updateContinuity(Continuity& state,
                                 const aribtlv::AccessUnit& unit);
    static void updateVideo(LayerTracker& tracker,
                            const aribtlv::AccessUnit& unit);
    static bool updateAudio(LayerTracker& tracker,
                            const aribtlv::AccessUnit& unit);
    static bool usableAt(const LayerTracker& tracker,
                         std::int64_t presentation_time_us,
                         bool require_healthy_baseline);
    static bool usableForStartup(const LayerTracker& tracker);
    static void markDamaged(LayerTracker& tracker,
                            std::int64_t end_time_us);
    static void discardDeferredDecision(LayerTracker& tracker) noexcept;

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
    VideoLayerObservation maybeCompleteRecovery(LayerTracker& tracker);
    bool audioContinuous(const LayerTracker& tracker) const noexcept;
    void setState(MseAvRecoveryState state) noexcept { state_ = state; }

    std::optional<VideoLayerPair> pair_;
    std::optional<std::uint64_t> selected_video_id_;
    std::optional<std::int64_t> playback_position_us_;
    bool selected_output_started_ = false;
    bool enabled_ = false;
    MseAvRecoveryState state_ = MseAvRecoveryState::Starting;
    std::uint64_t generation_ = 1;
    std::uint64_t next_episode_id_ = 1;
    LayerTracker preferred_;
    LayerTracker fallback_;
};

} // namespace tlvdemux::detail::mse
