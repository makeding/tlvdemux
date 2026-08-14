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
    pair_ = pair;
}

void VideoLayerStateMachine::clearConfiguration() noexcept {
    pair_.reset();
    pending_video_id_.reset();
}

void VideoLayerStateMachine::select(
    const std::optional<std::uint64_t> video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    pending_video_id_.reset();
}

void VideoLayerStateMachine::switchStarted(
    const std::uint64_t video_track_id) noexcept {
    pending_video_id_ = video_track_id;
}

void VideoLayerStateMachine::resetObservations() noexcept {
    tracks_.clear();
    pending_video_id_.reset();
}

void VideoLayerStateMachine::switchCompleted(
    const std::uint64_t video_track_id) noexcept {
    selected_video_id_ = video_track_id;
    pending_video_id_.reset();
}

void VideoLayerStateMachine::switchCancelled(
    const std::uint64_t previous_video_track_id) noexcept {
    selected_video_id_ = previous_video_track_id == 0
        ? std::nullopt
        : std::optional<std::uint64_t>{previous_video_track_id};
    pending_video_id_.reset();
}

void VideoLayerStateMachine::update(
    TrackState& state, const aribtlv::AccessUnit& unit) {
    const auto dts_us = timestamp_us(unit.dts);
    const auto pts_us = timestamp_us(unit.pts);
    const bool decode_break = state.last_dts_us.has_value() &&
        (unit.discontinuity || dts_us <= *state.last_dts_us ||
         dts_us - *state.last_dts_us > kMaximumDecodeGapUs);

    if (!state.last_dts_us.has_value()) {
        state.clean_since_dts_us = dts_us;
    } else if (decode_break) {
        state.clean_since_dts_us = dts_us;
        state.healthy = false;
        if (state.baseline_established) {
            state.recent_breaks = state.last_break_dts_us.has_value() &&
                dts_us > *state.last_break_dts_us &&
                dts_us - *state.last_break_dts_us <= kBreakWindowUs
                ? state.recent_breaks + 1 : 1;
            state.last_break_dts_us = dts_us;
        }
    } else if (state.clean_since_dts_us.has_value() &&
               dts_us - *state.clean_since_dts_us >= kHealthBaselineUs) {
        state.baseline_established = true;
        state.healthy = true;
        state.recent_breaks = 0;
    }

    state.last_dts_us = dts_us;
    if (!state.last_pts_us.has_value() || pts_us > *state.last_pts_us) {
        state.last_pts_us = pts_us;
    }
    if (unit.random_access) state.last_rap_pts_us = pts_us;
}

std::optional<VideoLayerSwitchRequest> VideoLayerStateMachine::observe(
    const aribtlv::AccessUnit& unit) {
    if (unit.codec != aribtlv::Codec::Hevc || unit.pts.timescale <= 1 ||
        unit.dts.timescale <= 1) return std::nullopt;
    update(tracks_[unit.track_id], unit);
    return decide();
}

std::optional<VideoLayerSwitchRequest> VideoLayerStateMachine::decide() {
    if (!pair_.has_value() || !selected_video_id_.has_value() ||
        pending_video_id_.has_value()) return std::nullopt;
    const auto current = tracks_.find(*selected_video_id_);
    if (current == tracks_.end() || !current->second.last_pts_us.has_value()) {
        return std::nullopt;
    }

    std::uint64_t target_video_id = 0;
    std::uint64_t target_audio_id = 0;
    if (*selected_video_id_ == pair_->preferred_video_id) {
        if (current->second.recent_breaks < kBreakThreshold) return std::nullopt;
        target_video_id = pair_->fallback_video_id;
        target_audio_id = pair_->fallback_audio_id;
    } else if (*selected_video_id_ == pair_->fallback_video_id) {
        target_video_id = pair_->preferred_video_id;
        target_audio_id = pair_->preferred_audio_id;
    } else {
        return std::nullopt;
    }

    const auto target = tracks_.find(target_video_id);
    if (target == tracks_.end() || !target->second.healthy ||
        !target->second.last_rap_pts_us.has_value()) return std::nullopt;
    const auto current_pts = *current->second.last_pts_us;
    const auto target_rap = *target->second.last_rap_pts_us;
    if (target_rap + kRapBehindToleranceUs < current_pts ||
        target_rap > current_pts + kRapAheadToleranceUs) return std::nullopt;

    if (*selected_video_id_ == pair_->preferred_video_id) {
        auto& preferred = tracks_.at(pair_->preferred_video_id);
        preferred.healthy = false;
        preferred.clean_since_dts_us = preferred.last_dts_us;
        preferred.recent_breaks = 0;
    }
    pending_video_id_ = target_video_id;
    return VideoLayerSwitchRequest{
        target_video_id,
        target_audio_id,
        std::max<std::int64_t>(0, current_pts - kSwitchPrerollUs),
    };
}

} // namespace tlvdemux::detail::mse
