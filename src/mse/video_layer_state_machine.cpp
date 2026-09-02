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
constexpr std::int64_t kRecoveryStableWindowUs = 500000;

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
    if (!selected_output_started_) state_ = MseAvRecoveryState::Starting;
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
    state_ = MseAvRecoveryState::Starting;
}

void VideoLayerStateMachine::select(
    const std::optional<std::uint64_t> video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    selected_output_started_ = false;
    clearUnrecoveredDamage();
    state_ = MseAvRecoveryState::Starting;
}

void VideoLayerStateMachine::resetObservations() noexcept {
    preferred_ = {};
    fallback_ = {};
    selected_output_started_ = false;
    playback_position_us_.reset();
    state_ = MseAvRecoveryState::Starting;
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
    state_ = MseAvRecoveryState::Av;
}

void VideoLayerStateMachine::setSelectedOutputStarted(const bool started) noexcept {
    selected_output_started_ = started;
    if (started && state_ == MseAvRecoveryState::Starting) {
        state_ = MseAvRecoveryState::Av;
    }
}

void VideoLayerStateMachine::setPlaybackPosition(
    const std::int64_t presentation_time_us) noexcept {
    playback_position_us_ = std::max<std::int64_t>(0, presentation_time_us);
}

void VideoLayerStateMachine::setGeneration(const std::uint64_t generation) noexcept {
    if (generation_ == generation) return;
    generation_ = generation;
    preferred_.recovery_rap.reset();
    fallback_.recovery_rap.reset();
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

bool VideoLayerStateMachine::updateAudio(
    LayerTracker& tracker, const aribtlv::AccessUnit& unit) {
    const bool decode_break = updateContinuity(tracker.audio, unit);
    const auto pts_us = timestamp_us(unit.pts);
    tracker.recent_audio_pts_us.push_back(pts_us);
    while (!tracker.recent_audio_pts_us.empty() &&
           pts_us - tracker.recent_audio_pts_us.front() > kSwitchObservationWindowUs) {
        tracker.recent_audio_pts_us.pop_front();
    }
    return decode_break;
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
        tracker.unrecovered_damage.has_value() || tracker.recent_raps.empty()) {
        return false;
    }
    return std::any_of(
        tracker.recent_raps.begin(), tracker.recent_raps.end(),
        [&tracker, presentation_time_us](const Rap& rap) {
            if (rap.pts_us + kRapBehindToleranceUs < presentation_time_us ||
                rap.pts_us > presentation_time_us + kRapAheadToleranceUs) {
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
    tracker.recovery_rap.reset();
}

void VideoLayerStateMachine::discardDeferredDecision(
    LayerTracker& tracker) noexcept {
    tracker = {};
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
    if (!usableAt(*target, current_pts, require_healthy_baseline)) {
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
    result.state = state_;
    if (!enabled_) return result;
    const auto* current = activeLayer();
    if (!current) return result;
    if (const auto startup = requestStartupFallback()) {
        result.switch_request = startup;
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
        result.state = MseAvRecoveryState::Switching;
        return result;
    }
    if (current->unrecovered_damage.has_value()) {
        result.switch_request = requestOtherLayer(false);
        result.switch_reason = VideoLayerSwitchReason::SourceDamage;
        if (result.switch_request) result.state = MseAvRecoveryState::Switching;
        return result;
    }
    if (current->recent_breaks >= kBreakThreshold) {
        result.switch_request = requestOtherLayer(false);
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
        if (result.switch_request) result.state = MseAvRecoveryState::Switching;
        return result;
    }
    if (pair_ && selected_video_id_ == pair_->fallback_video_id) {
        result.switch_request = requestOtherLayer(true);
        result.switch_reason = VideoLayerSwitchReason::HealthDegradation;
        if (result.switch_request) result.state = MseAvRecoveryState::Switching;
    }
    return result;
}

bool VideoLayerStateMachine::audioContinuous(
    const LayerTracker& tracker) const noexcept {
    return tracker.audio.last_dts_us.has_value() &&
        tracker.audio.clean_since_dts_us.has_value() &&
        *tracker.audio.last_dts_us > *tracker.audio.clean_since_dts_us &&
        tracker.audio.last_pts_us.has_value();
}

VideoLayerObservation VideoLayerStateMachine::maybeCompleteRecovery(
    LayerTracker& tracker) {
    VideoLayerObservation result;
    result.state = state_;
    if (!pair_ || !selected_video_id_ || !tracker.recovery_rap ||
        tracker.recovery_generation != generation_ ||
        !tracker.unrecovered_damage || !tracker.video.last_dts_us ||
        !tracker.video.clean_since_dts_us ||
        *tracker.video.last_dts_us - *tracker.video.clean_since_dts_us <
            kRecoveryStableWindowUs ||
        tracker.recovery_rap->dts_us - *tracker.video.clean_since_dts_us <
            kRecoveryStableWindowUs ||
        !audioContinuous(tracker)) {
        return result;
    }
    const auto audio = std::find_if(
        tracker.recent_audio_pts_us.begin(), tracker.recent_audio_pts_us.end(),
        [&tracker](const std::int64_t pts_us) {
            return pts_us >= tracker.recovery_rap->pts_us &&
                pts_us - tracker.recovery_rap->pts_us <= kStartupAudioAlignmentUs;
        });
    if (audio == tracker.recent_audio_pts_us.end()) return result;

    const bool preferred = *selected_video_id_ == pair_->preferred_video_id;
    const auto evidence = MseAvRecoveryEvidence{
        MseAvRecoveryState::Restoring,
        state_,
        tracker.recovery_episode_id,
        *selected_video_id_,
        preferred ? pair_->preferred_audio_id : pair_->fallback_audio_id,
        tracker.recovery_rap->pts_us,
        std::max(tracker.recovery_rap->pts_us, *audio),
        tracker.recovery_rap->restart_offset,
        playback_position_us_.value_or(tracker.recovery_rap->pts_us),
        generation_,
    };
    tracker.unrecovered_damage.reset();
    tracker.recovery_rap.reset();
    state_ = MseAvRecoveryState::Restoring;
    result.state = state_;
    result.recovery_evidence = evidence;
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
            tracker->recovery_episode_id = next_episode_id_++;
            tracker->recovery_generation = generation_;
            tracker->recovery_origin_state = audioContinuous(*tracker)
                ? MseAvRecoveryState::HeldAudio : MseAvRecoveryState::Stalled;
            state_ = tracker->recovery_origin_state;
            result = decide();
            result.state = state_;
            result.recovery_evidence = MseAvRecoveryEvidence{
                state_, state_, tracker->recovery_episode_id,
                unit.track_id,
                unit.track_id == pair_->preferred_video_id
                    ? pair_->preferred_audio_id : pair_->fallback_audio_id,
                0, 0, 0, playback_position_us_.value_or(end), generation_,
            };
            if (!result.switch_request && unit.track_id == *selected_video_id_) {
                result.playback_damage = tracker->unrecovered_damage;
            }
            return result;
        }
        if (unit.random_access && tracker->unrecovered_damage.has_value()) {
            tracker->recovery_rap = Rap{
                timestamp_us(unit.pts), timestamp_us(unit.dts),
                unit.input_offset, unit.restart_offset};
            if (!tracker->video.clean_since_dts_us ||
                *tracker->video.last_dts_us ==
                    *tracker->video.clean_since_dts_us) {
                tracker->video.clean_since_dts_us = timestamp_us(unit.dts);
                tracker->video.healthy = false;
            }
            tracker->recent_breaks = 0;
            if (unit.track_id != *selected_video_id_ &&
                tracker->video.healthy && tracker->audio.healthy) {
                // The inactive preferred pair has now proved the full
                // five-second restoration baseline. Its old damage episode
                // must no longer veto the ordinary atomic fallback->preferred
                // decision made below.
                tracker->unrecovered_damage.reset();
                tracker->recovery_rap.reset();
                return decide();
            }
            if (unit.track_id == *selected_video_id_) {
                const auto recovery = maybeCompleteRecovery(*tracker);
                if (recovery.recovery_evidence) return recovery;
            }
            return result;
        }
    } else if (unit.codec == aribtlv::Codec::AacLatm) {
        LayerTracker* audio_tracker = nullptr;
        bool audio_break = false;
        if (unit.track_id == pair_->preferred_audio_id) {
            audio_break = updateAudio(preferred_, unit);
            audio_tracker = &preferred_;
        }
        if (unit.track_id == pair_->fallback_audio_id) {
            audio_break = updateAudio(fallback_, unit);
            audio_tracker = &fallback_;
        }
        if (audio_tracker && audio_tracker == activeLayer() &&
            audio_tracker->unrecovered_damage) {
            if (audio_break || !audioContinuous(*audio_tracker)) {
                state_ = MseAvRecoveryState::Stalled;
            }
            const auto recovery = maybeCompleteRecovery(*audio_tracker);
            if (recovery.recovery_evidence) return recovery;
        }
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
    if (!already_waiting) {
        tracker->recovery_episode_id = next_episode_id_++;
        tracker->recovery_generation = generation_;
    }
    tracker->recovery_origin_state = audioContinuous(*tracker)
        ? MseAvRecoveryState::HeldAudio : MseAvRecoveryState::Stalled;
    state_ = tracker->recovery_origin_state;
    result = decide();
    if (result.switch_request.has_value()) {
        state_ = MseAvRecoveryState::Switching;
        result.state = state_;
        return result;
    }
    result.recovery_evidence = MseAvRecoveryEvidence{
        state_, state_, tracker->recovery_episode_id,
        damage.video_track_id,
        damage.video_track_id == pair_->preferred_video_id
            ? pair_->preferred_audio_id : pair_->fallback_audio_id,
        0, 0, 0, playback_position_us_.value_or(damage.end_time_us), generation_,
    };

    auto waiting = damage;
    if (damage.recovery_time_us && damage.recovery_restart_offset != 0) {
        tracker->recovery_rap = Rap{
            *damage.recovery_time_us, *damage.recovery_time_us,
            damage.recovery_input_offset, damage.recovery_restart_offset};
    }
    waiting.recovery_time_us.reset();
    waiting.recovery_input_offset = 0;
    waiting.recovery_restart_offset = 0;
    waiting.action = PlaybackRecoveryAction::WaitForRecovery;
    tracker->unrecovered_damage = waiting;
    if (!already_waiting) result.playback_damage = waiting;
    result.state = state_;
    return result;
}

} // namespace tlvdemux::detail::mse
