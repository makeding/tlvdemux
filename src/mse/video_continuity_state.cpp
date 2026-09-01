#include "video_continuity_state.hpp"

#include <algorithm>

namespace tlvdemux::detail::mse {

const char* video_continuity_phase_name(const VideoContinuityPhase phase) noexcept {
    switch (phase) {
    case VideoContinuityPhase::Normal: return "normal";
    case VideoContinuityPhase::DamageSealed: return "damage-sealed";
    case VideoContinuityPhase::FallbackPending: return "fallback-pending";
    case VideoContinuityPhase::Frozen: return "frozen";
    case VideoContinuityPhase::PreferredCandidate: return "preferred-candidate";
    case VideoContinuityPhase::Restoring: return "restoring";
    }
    return "normal";
}

void VideoContinuityState::reset() noexcept {
    snapshot_ = {};
}

void VideoContinuityState::sealDamage(const std::int64_t start_us) noexcept {
    snapshot_.phase = VideoContinuityPhase::DamageSealed;
    if (!snapshot_.damage_start_us) snapshot_.damage_start_us = start_us;
    snapshot_.candidate_rap_us.reset();
}

void VideoContinuityState::awaitFallback(const std::uint64_t track_id) noexcept {
    snapshot_.phase = VideoContinuityPhase::FallbackPending;
    snapshot_.fallback_track_id = track_id;
}

void VideoContinuityState::freeze() noexcept {
    snapshot_.phase = VideoContinuityPhase::Frozen;
    snapshot_.fallback_track_id.reset();
}

PreferredContinuityDecision VideoContinuityState::observePreferred(
    const std::int64_t presentation_time_us, const bool random_access,
    const bool source_damage) noexcept {
    if (snapshot_.phase == VideoContinuityPhase::Normal) {
        return PreferredContinuityDecision::Pass;
    }
    if (source_damage) {
        const bool rejected = snapshot_.phase == VideoContinuityPhase::PreferredCandidate;
        snapshot_.candidate_rap_us.reset();
        snapshot_.phase = snapshot_.fallback_track_id
            ? VideoContinuityPhase::FallbackPending
            : VideoContinuityPhase::Frozen;
        return rejected ? PreferredContinuityDecision::CandidateRejected
                        : PreferredContinuityDecision::Discard;
    }
    if (snapshot_.phase == VideoContinuityPhase::DamageSealed) {
        return PreferredContinuityDecision::Discard;
    }
    if (snapshot_.phase == VideoContinuityPhase::Frozen ||
        snapshot_.phase == VideoContinuityPhase::FallbackPending) {
        if (random_access) {
            snapshot_.candidate_rap_us = presentation_time_us;
            snapshot_.phase = VideoContinuityPhase::PreferredCandidate;
        }
        return PreferredContinuityDecision::Discard;
    }
    if (snapshot_.phase == VideoContinuityPhase::PreferredCandidate) {
        if (!random_access) return PreferredContinuityDecision::Discard;
        snapshot_.phase = VideoContinuityPhase::Restoring;
        return PreferredContinuityDecision::Restore;
    }
    return PreferredContinuityDecision::Pass;
}

void VideoContinuityState::completeRestoration() noexcept {
    snapshot_.phase = VideoContinuityPhase::Normal;
    snapshot_.damage_start_us.reset();
    snapshot_.frozen_through_us.reset();
    snapshot_.candidate_rap_us.reset();
    snapshot_.fallback_track_id.reset();
}

void VideoContinuityState::noteAacFrontier(const std::int64_t end_us) noexcept {
    snapshot_.aac_frontier_us = !snapshot_.aac_frontier_us
        ? end_us : std::max(*snapshot_.aac_frontier_us, end_us);
}

void VideoContinuityState::noteFrozenThrough(const std::int64_t end_us) noexcept {
    snapshot_.frozen_through_us = !snapshot_.frozen_through_us
        ? end_us : std::max(*snapshot_.frozen_through_us, end_us);
}

void VideoContinuityState::noteVideoOutputEnd(const std::int64_t end_us) noexcept {
    snapshot_.last_video_output_end_us = !snapshot_.last_video_output_end_us
        ? end_us : std::max(*snapshot_.last_video_output_end_us, end_us);
}

} // namespace tlvdemux::detail::mse
