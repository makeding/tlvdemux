#include "video_layer_state_machine.hpp"

#include <algorithm>
#include <cstdlib>

namespace tlvdemux::detail::mse {
namespace {

constexpr std::int64_t kMaximumDecodeGapUs = 500000;
constexpr std::int64_t kHealthBaselineUs = 5000000;
constexpr std::int64_t kBreakWindowUs = 2000000;
constexpr unsigned kBreakThreshold = 3;
constexpr std::int64_t kRapBehindToleranceUs = 500000;
constexpr std::int64_t kRapAheadToleranceUs = 2000000;
constexpr std::int64_t kSwitchPrerollUs = 3000000;
constexpr std::int64_t kStartupAudioAlignmentUs = 22000;
constexpr std::int64_t kSwitchObservationWindowUs = 20000000;

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
    enabled_ = true;
}

void VideoLayerStateMachine::suspend() noexcept {
    enabled_ = false;
}

void VideoLayerStateMachine::resume() noexcept {
    enabled_ = pair_.has_value();
}

void VideoLayerStateMachine::clearConfiguration() noexcept {
    enabled_ = false;
    pair_.reset();
    preferred_ = {};
    fallback_ = {};
}

void VideoLayerStateMachine::select(
    const std::optional<std::uint64_t> video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    selected_output_started_ = false;
    playback_position_advancing_ = false;
    clearUnrecoveredDamage();
}

void VideoLayerStateMachine::resetObservations() noexcept {
    preferred_ = {};
    fallback_ = {};
    selected_output_started_ = false;
    playback_position_us_.reset();
    playback_position_advancing_ = false;
}

void VideoLayerStateMachine::clearUnrecoveredDamage() noexcept {
    preferred_.unrecovered_damage.reset();
    fallback_.unrecovered_damage.reset();
}

void VideoLayerStateMachine::discardDeferredDecision() noexcept {
    discardDeferredDecision(preferred_);
    discardDeferredDecision(fallback_);
}

void VideoLayerStateMachine::switchCompleted(
    const std::uint64_t video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    selected_output_started_ = true;
}

void VideoLayerStateMachine::setSelectedOutputStarted(const bool started) noexcept {
    selected_output_started_ = started;
}

void VideoLayerStateMachine::setPlaybackPosition(
    const std::int64_t presentation_time_us) noexcept {
    const auto position = std::max<std::int64_t>(0, presentation_time_us);
    playback_position_advancing_ = playback_position_us_.has_value() &&
        position > *playback_position_us_;
    playback_position_us_ = position;
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
            timestamp_us(unit.pts), timestamp_us(unit.dts),
            unit.input_offset, unit.restart_offset};
        tracker.recent_raps.push_back(*tracker.last_rap);
        while (!tracker.recent_raps.empty() &&
               tracker.last_rap->pts_us - tracker.recent_raps.front().pts_us >
                   kSwitchObservationWindowUs) {
            tracker.recent_raps.pop_front();
        }
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
    const auto pts_us = timestamp_us(unit.pts);
    tracker.recent_audio_pts_us.push_back(pts_us);
    while (!tracker.recent_audio_pts_us.empty() &&
           pts_us - tracker.recent_audio_pts_us.front() > kSwitchObservationWindowUs) {
        tracker.recent_audio_pts_us.pop_front();
    }
}

bool VideoLayerStateMachine::usableAt(
    const LayerTracker& tracker, const std::int64_t presentation_time_us,
    const bool require_healthy_baseline,
    const std::int64_t maximum_rap_ahead_us) {
    const auto continuous = [](const Continuity& continuity) {
        return continuity.last_dts_us.has_value() &&
            continuity.clean_since_dts_us.has_value() &&
            *continuity.last_dts_us > *continuity.clean_since_dts_us;
    };
    if ((require_healthy_baseline &&
         (!tracker.video.healthy || !tracker.audio.healthy)) ||
        !continuous(tracker.video) || !continuous(tracker.audio) ||
        tracker.unrecovered_damage.has_value() || tracker.recent_raps.empty()) {
        return false;
    }
    return std::any_of(
        tracker.recent_raps.begin(), tracker.recent_raps.end(),
        [&tracker, presentation_time_us, maximum_rap_ahead_us](const Rap& rap) {
            if (rap.pts_us + kRapBehindToleranceUs < presentation_time_us ||
                rap.pts_us > presentation_time_us + maximum_rap_ahead_us) {
                return false;
            }
            return std::any_of(
                tracker.recent_audio_pts_us.begin(),
                tracker.recent_audio_pts_us.end(),
                [&rap](const std::int64_t audio_pts_us) {
                    return std::llabs(audio_pts_us - rap.pts_us) <=
                        kStartupAudioAlignmentUs;
                });
        });
}

bool VideoLayerStateMachine::usableForStartup(const LayerTracker& tracker) {
    const auto continuous = [](const Continuity& continuity) {
        return continuity.last_dts_us.has_value() &&
            continuity.clean_since_dts_us.has_value() &&
            *continuity.last_dts_us > *continuity.clean_since_dts_us;
    };
    if (!continuous(tracker.video) || !continuous(tracker.audio) ||
        tracker.unrecovered_damage.has_value() || !tracker.last_rap.has_value()) {
        return false;
    }
    const auto& rap = *tracker.last_rap;
    if (!tracker.video.last_dts_us.has_value() ||
        *tracker.video.last_dts_us <= rap.dts_us) return false;
    return std::any_of(
        tracker.recent_audio_pts_us.begin(), tracker.recent_audio_pts_us.end(),
        [&rap](const std::int64_t audio_pts_us) {
            return audio_pts_us >= rap.pts_us &&
                audio_pts_us - rap.pts_us <= kStartupAudioAlignmentUs;
        });
}

void VideoLayerStateMachine::markDamaged(
    LayerTracker& tracker, const std::int64_t end_time_us) {
    tracker.video.healthy = false;
    tracker.video.clean_since_dts_us = end_time_us;
    tracker.recent_breaks = std::max(tracker.recent_breaks, kBreakThreshold);
    tracker.recent_raps.clear();
    tracker.recent_audio_pts_us.clear();
}

void VideoLayerStateMachine::discardDeferredDecision(
    LayerTracker& tracker) noexcept {
    tracker.unrecovered_damage.reset();
    tracker.recent_breaks = 0;
    tracker.last_break_dts_us.reset();
    tracker.last_rap.reset();
    tracker.recent_raps.clear();
    tracker.recent_audio_pts_us.clear();
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
    if (!current || !target) {
        return std::nullopt;
    }
    std::optional<std::int64_t> decision_position;
    if (require_healthy_baseline && pair_ &&
        selected_video_id_ == pair_->fallback_video_id) {
        decision_position = playback_position_us_;
    } else {
        decision_position = current->video.last_pts_us;
    }
    if (!decision_position) return std::nullopt;
    const auto current_pts = *decision_position;
    const auto maximum_rap_ahead_us = require_healthy_baseline &&
        playback_position_advancing_
        ? kSwitchObservationWindowUs : kRapAheadToleranceUs;
    if (!usableAt(*target, current_pts, require_healthy_baseline,
                  maximum_rap_ahead_us)) {
        return std::nullopt;
    }
    const bool preferred_active = *selected_video_id_ == pair_->preferred_video_id;
    return VideoLayerSwitchRequest{
        preferred_active ? pair_->fallback_video_id : pair_->preferred_video_id,
        preferred_active ? pair_->fallback_audio_id : pair_->preferred_audio_id,
        require_healthy_baseline ? current_pts
                                 : std::max<std::int64_t>(0, current_pts - kSwitchPrerollUs),
    };
}

std::optional<VideoLayerSwitchRequest>
VideoLayerStateMachine::requestStartupFallback() const {
    if (!pair_ || selected_video_id_ != pair_->preferred_video_id ||
        selected_output_started_ || !usableForStartup(fallback_)) {
        return std::nullopt;
    }
    return VideoLayerSwitchRequest{
        pair_->fallback_video_id,
        pair_->fallback_audio_id,
        0,
    };
}

VideoLayerObservation VideoLayerStateMachine::decide() const {
    VideoLayerObservation result;
    if (!enabled_) return result;
    const auto* current = activeLayer();
    if (!current) return result;
    if (const auto startup = requestStartupFallback()) {
        result.switch_request = startup;
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
        return result;
    }
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

VideoLayerObservation VideoLayerStateMachine::reevaluate() const {
    return decide();
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

    // A recorded-seek fence suspends decisions while observations continue.
    // Retain a recovered severe episode until resume()/reevaluate() so the
    // exact committed target, rather than a fresh-startup health fallback,
    // owns the one post-seek decision.
    if (!enabled_ && pair_.has_value()) return result;

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
