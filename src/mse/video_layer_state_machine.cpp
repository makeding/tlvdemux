#include "video_layer_state_machine.hpp"

#include <algorithm>

namespace tlvdemux::detail::mse {
namespace {

constexpr std::int64_t kMaximumDecodeGapUs = 500000;
constexpr std::int64_t kHealthBaselineUs = 5000000;
constexpr std::int64_t kBreakWindowUs = 2000000;
constexpr unsigned kBreakThreshold = 3;
constexpr std::int64_t kRapBehindToleranceUs = 500000;
constexpr std::int64_t kRapAheadToleranceUs = 2000000;
constexpr std::int64_t kAudioBehindToleranceUs = 500000;
constexpr std::int64_t kAudioAheadToleranceUs = 2000000;
constexpr std::int64_t kSwitchPrerollUs = 3000000;

std::int64_t timestamp_us(const aribtlv::Timestamp timestamp) {
    return timestamp.value * 1000000 /
        static_cast<std::int64_t>(timestamp.timescale);
}

} // namespace

void VideoLayerStateMachine::configure(const VideoLayerPair pair) {
    if (pair.preferred_video_id == 0 || pair.preferred_audio_id == 0 ||
        pair.fallback_video_id == 0 || pair.fallback_audio_id == 0 ||
        pair.preferred_video_id == pair.fallback_video_id) {
        clearConfiguration();
        return;
    }
    if (!pair_.has_value() || pair_->preferred_video_id != pair.preferred_video_id ||
        pair_->preferred_audio_id != pair.preferred_audio_id ||
        pair_->fallback_video_id != pair.fallback_video_id ||
        pair_->fallback_audio_id != pair.fallback_audio_id) {
        preferred_ = {};
        fallback_ = {};
    }
    pair_ = pair;
}

void VideoLayerStateMachine::clearConfiguration() noexcept {
    pair_.reset();
    preferred_ = {};
    fallback_ = {};
}

void VideoLayerStateMachine::select(
    const std::optional<std::uint64_t> video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    clearUnrecoveredDamage();
}

void VideoLayerStateMachine::resetObservations() noexcept {
    preferred_ = {};
    fallback_ = {};
}

void VideoLayerStateMachine::clearUnrecoveredDamage() noexcept {
    preferred_.unrecovered_damage.reset();
    fallback_.unrecovered_damage.reset();
}

void VideoLayerStateMachine::switchCompleted(
    const std::uint64_t video_track_id) noexcept {
    selected_video_id_ = video_track_id;
}

bool VideoLayerStateMachine::updateContinuity(
    Continuity& state, const aribtlv::AccessUnit& unit) {
    const auto dts_us = timestamp_us(unit.dts);
    const auto pts_us = timestamp_us(unit.pts);
    const bool decode_break = state.last_dts_us.has_value() &&
        (dts_us <= *state.last_dts_us ||
         dts_us - *state.last_dts_us > kMaximumDecodeGapUs);

    if (!state.last_dts_us.has_value()) {
        state.clean_since_dts_us = dts_us;
    } else if (decode_break) {
        state.clean_since_dts_us = dts_us;
        state.healthy = false;
    } else if (state.clean_since_dts_us.has_value() &&
               dts_us - *state.clean_since_dts_us >= kHealthBaselineUs) {
        state.baseline_established = true;
        state.healthy = true;
    }

    state.last_dts_us = dts_us;
    if (!state.last_pts_us.has_value() || pts_us > *state.last_pts_us) {
        state.last_pts_us = pts_us;
    }
    return decode_break;
}

void VideoLayerStateMachine::updateVideo(
    LayerTracker& tracker, const aribtlv::AccessUnit& unit) {
    const auto dts_us = timestamp_us(unit.dts);
    const bool decode_break = updateContinuity(tracker.video, unit);
    const bool explicit_source_damage = unit.discontinuity &&
        aribtlv::hasDiscontinuityReason(
            unit.discontinuity_reasons,
            aribtlv::DiscontinuityReason::SourceDamage);
    if (decode_break || explicit_source_damage) {
        tracker.video.clean_since_dts_us = dts_us;
        tracker.video.healthy = false;
        if (tracker.video.baseline_established) {
            tracker.recent_breaks = tracker.last_break_dts_us.has_value() &&
                dts_us > *tracker.last_break_dts_us &&
                dts_us - *tracker.last_break_dts_us <= kBreakWindowUs
                ? tracker.recent_breaks + 1 : 1;
            tracker.last_break_dts_us = dts_us;
        }
    } else if (tracker.video.healthy) {
        tracker.recent_breaks = 0;
    }
    if (unit.random_access) {
        tracker.last_rap = Rap{
            timestamp_us(unit.pts), unit.input_offset, unit.restart_offset};
        if (explicit_source_damage) {
            // This AU is the decoder restart point, not another independent
            // degradation vote after the core already published its recovery.
            tracker.recent_breaks = 0;
            tracker.last_break_dts_us.reset();
        }
    }
}

void VideoLayerStateMachine::updateAudio(
    LayerTracker& tracker, const aribtlv::AccessUnit& unit) {
    updateContinuity(tracker.audio, unit);
}

bool VideoLayerStateMachine::usableAt(
    const LayerTracker& tracker, const std::int64_t presentation_time_us,
    const bool require_healthy_baseline) {
    const auto continuous = [](const Continuity& continuity) {
        return continuity.last_dts_us.has_value() &&
            continuity.clean_since_dts_us.has_value() &&
            *continuity.last_dts_us > *continuity.clean_since_dts_us;
    };
    if ((require_healthy_baseline &&
         (!tracker.video.healthy || !tracker.audio.healthy)) ||
        !continuous(tracker.video) || !continuous(tracker.audio) ||
        tracker.unrecovered_damage.has_value() || !tracker.last_rap.has_value() ||
        !tracker.audio.last_pts_us.has_value()) return false;
    const auto rap = tracker.last_rap->pts_us;
    const auto audio = *tracker.audio.last_pts_us;
    return rap + kRapBehindToleranceUs >= presentation_time_us &&
        rap <= presentation_time_us + kRapAheadToleranceUs &&
        audio + kAudioBehindToleranceUs >= rap &&
        audio <= presentation_time_us + kAudioAheadToleranceUs;
}

void VideoLayerStateMachine::markDamaged(
    LayerTracker& tracker, const std::int64_t end_time_us) {
    tracker.video.healthy = false;
    tracker.video.clean_since_dts_us = end_time_us;
    tracker.recent_breaks = std::max(tracker.recent_breaks, kBreakThreshold);
}

VideoLayerStateMachine::LayerTracker* VideoLayerStateMachine::layerForVideo(
    const std::uint64_t track_id) noexcept {
    if (!pair_) return nullptr;
    if (track_id == pair_->preferred_video_id) return &preferred_;
    if (track_id == pair_->fallback_video_id) return &fallback_;
    return nullptr;
}

const VideoLayerStateMachine::LayerTracker*
VideoLayerStateMachine::layerForVideo(const std::uint64_t track_id) const noexcept {
    if (!pair_) return nullptr;
    if (track_id == pair_->preferred_video_id) return &preferred_;
    if (track_id == pair_->fallback_video_id) return &fallback_;
    return nullptr;
}

VideoLayerStateMachine::LayerTracker* VideoLayerStateMachine::activeLayer() noexcept {
    return selected_video_id_ ? layerForVideo(*selected_video_id_) : nullptr;
}

const VideoLayerStateMachine::LayerTracker*
VideoLayerStateMachine::activeLayer() const noexcept {
    return selected_video_id_ ? layerForVideo(*selected_video_id_) : nullptr;
}

VideoLayerStateMachine::LayerTracker* VideoLayerStateMachine::otherLayer() noexcept {
    if (!pair_ || !selected_video_id_) return nullptr;
    if (*selected_video_id_ == pair_->preferred_video_id) return &fallback_;
    if (*selected_video_id_ == pair_->fallback_video_id) return &preferred_;
    return nullptr;
}

const VideoLayerStateMachine::LayerTracker*
VideoLayerStateMachine::otherLayer() const noexcept {
    if (!pair_ || !selected_video_id_) return nullptr;
    if (*selected_video_id_ == pair_->preferred_video_id) return &fallback_;
    if (*selected_video_id_ == pair_->fallback_video_id) return &preferred_;
    return nullptr;
}

std::optional<VideoLayerSwitchRequest>
VideoLayerStateMachine::requestOtherLayer(
    const bool require_healthy_baseline) const {
    if (!pair_ || !selected_video_id_) return std::nullopt;
    const auto* current = activeLayer();
    const auto* target = otherLayer();
    if (!current || !target || !current->video.last_pts_us.has_value()) {
        return std::nullopt;
    }
    const auto current_pts = *current->video.last_pts_us;
    if (!usableAt(*target, current_pts, require_healthy_baseline)) {
        return std::nullopt;
    }
    const bool preferred_active = *selected_video_id_ == pair_->preferred_video_id;
    return VideoLayerSwitchRequest{
        preferred_active ? pair_->fallback_video_id : pair_->preferred_video_id,
        preferred_active ? pair_->fallback_audio_id : pair_->preferred_audio_id,
        std::max<std::int64_t>(0, current_pts - kSwitchPrerollUs),
    };
}

VideoLayerObservation VideoLayerStateMachine::decide() const {
    VideoLayerObservation result;
    const auto* current = activeLayer();
    if (!current) return result;
    if (current->unrecovered_damage.has_value()) {
        result.switch_request = requestOtherLayer(false);
        result.switch_reason = VideoLayerSwitchReason::SourceDamage;
        return result;
    }
    if (current->recent_breaks >= kBreakThreshold) {
        result.switch_request = requestOtherLayer(false);
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
        return result;
    }
    if (pair_ && selected_video_id_ == pair_->fallback_video_id) {
        result.switch_request = requestOtherLayer(true);
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
    }
    return result;
}

VideoLayerObservation VideoLayerStateMachine::observe(
    const aribtlv::AccessUnit& unit) {
    VideoLayerObservation result;
    if (!pair_ || !selected_video_id_ || unit.pts.timescale <= 1 ||
        unit.dts.timescale <= 1) return result;

    LayerTracker* tracker = nullptr;
    if (unit.codec == aribtlv::Codec::Hevc) {
        tracker = layerForVideo(unit.track_id);
        if (!tracker) return result;
        const auto previous_pts = tracker->video.last_pts_us;
        const bool source_damage = unit.discontinuity &&
            aribtlv::hasDiscontinuityReason(
                unit.discontinuity_reasons,
                aribtlv::DiscontinuityReason::SourceDamage);
        updateVideo(*tracker, unit);
        if (source_damage && !unit.random_access &&
            !tracker->unrecovered_damage.has_value()) {
            const auto end = timestamp_us(unit.pts);
            tracker->unrecovered_damage = PlaybackDamage{
                unit.track_id,
                previous_pts.has_value() ? previous_pts
                                         : std::optional<std::int64_t>{end},
                end,
                std::nullopt,
                unit.input_offset,
                unit.input_offset,
                0,
                0,
                PlaybackDamageSeverity::Severe,
                PlaybackRecoveryAction::WaitForRecovery,
            };
            markDamaged(*tracker, end);
            result = decide();
            if (!result.switch_request && unit.track_id == *selected_video_id_) {
                result.playback_damage = tracker->unrecovered_damage;
            }
            return result;
        }
        if (unit.random_access && tracker->unrecovered_damage.has_value()) {
            auto recovered = *tracker->unrecovered_damage;
            recovered.recovery_time_us = timestamp_us(unit.pts);
            recovered.recovery_input_offset = unit.input_offset;
            recovered.recovery_restart_offset = unit.restart_offset;
            recovered.action = PlaybackRecoveryAction::Seek;
            tracker->unrecovered_damage.reset();
            tracker->video.clean_since_dts_us = timestamp_us(unit.dts);
            tracker->video.healthy = false;
            tracker->recent_breaks = 0;
            if (unit.track_id == *selected_video_id_) {
                result.playback_damage = recovered;
                return result;
            }
        }
    } else if (unit.codec == aribtlv::Codec::AacLatm) {
        if (unit.track_id == pair_->preferred_audio_id) updateAudio(preferred_, unit);
        if (unit.track_id == pair_->fallback_audio_id) updateAudio(fallback_, unit);
    } else {
        return result;
    }
    return decide();
}

VideoLayerObservation VideoLayerStateMachine::observeDamage(
    const PlaybackDamage& damage) {
    VideoLayerObservation result;
    auto* tracker = layerForVideo(damage.video_track_id);
    if (!tracker || !selected_video_id_ ||
        damage.video_track_id != *selected_video_id_) return result;
    if (damage.severity != PlaybackDamageSeverity::Severe) {
        result.playback_damage = damage;
        return result;
    }

    const bool already_waiting = tracker->unrecovered_damage.has_value() &&
        damage.action == PlaybackRecoveryAction::WaitForRecovery &&
        !damage.recovery_time_us.has_value();
    markDamaged(*tracker, damage.end_time_us);
    tracker->unrecovered_damage = damage;
    result = decide();
    if (result.switch_request.has_value()) return result;

    if (damage.action == PlaybackRecoveryAction::Seek &&
        damage.recovery_time_us.has_value()) {
        tracker->unrecovered_damage.reset();
        result.playback_damage = damage;
    } else {
        auto waiting = damage;
        waiting.recovery_time_us.reset();
        waiting.recovery_input_offset = 0;
        waiting.recovery_restart_offset = 0;
        waiting.action = PlaybackRecoveryAction::WaitForRecovery;
        tracker->unrecovered_damage = waiting;
        if (!already_waiting) result.playback_damage = waiting;
    }
    return result;
}

} // namespace tlvdemux::detail::mse
