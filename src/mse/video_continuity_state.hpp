#pragma once

#include <cstdint>
#include <optional>

namespace tlvdemux::detail::mse {

enum class VideoContinuityPhase {
    Normal,
    DamageSealed,
    FallbackPending,
    Frozen,
    PreferredCandidate,
    Restoring,
};

const char* video_continuity_phase_name(VideoContinuityPhase phase) noexcept;

enum class PreferredContinuityDecision {
    Pass,
    Discard,
    CandidateRejected,
    Restore,
};

struct VideoContinuitySnapshot {
    VideoContinuityPhase phase = VideoContinuityPhase::Normal;
    std::optional<std::int64_t> damage_start_us;
    std::optional<std::int64_t> aac_frontier_us;
    std::optional<std::int64_t> frozen_through_us;
    std::optional<std::int64_t> candidate_rap_us;
    std::optional<std::uint64_t> fallback_track_id;
    std::optional<std::int64_t> last_video_output_end_us;
};

// Owns ordinary sequential-video continuity only. Byte reposition and explicit
// seek reset it; neither operation is interpreted as source damage.
class VideoContinuityState {
public:
    VideoContinuityPhase phase() const noexcept { return snapshot_.phase; }
    const VideoContinuitySnapshot& snapshot() const noexcept { return snapshot_; }

    void reset() noexcept;
    void sealDamage(std::int64_t start_us) noexcept;
    void awaitFallback(std::uint64_t track_id) noexcept;
    void freeze() noexcept;
    PreferredContinuityDecision observePreferred(
        std::int64_t presentation_time_us, bool random_access,
        bool source_damage) noexcept;
    void completeRestoration() noexcept;
    void noteAacFrontier(std::int64_t end_us) noexcept;
    void noteFrozenThrough(std::int64_t end_us) noexcept;
    void noteVideoOutputEnd(std::int64_t end_us) noexcept;

private:
    VideoContinuitySnapshot snapshot_;
};

} // namespace tlvdemux::detail::mse
