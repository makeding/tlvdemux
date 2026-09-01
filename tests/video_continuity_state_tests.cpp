#include "mse/video_continuity_state.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using tlvdemux::detail::mse::PreferredContinuityDecision;
using tlvdemux::detail::mse::VideoContinuityPhase;
using tlvdemux::detail::mse::VideoContinuityState;

void check(const bool condition, const std::string& message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void test_repeated_candidate_damage_keeps_frozen_continuity() {
    VideoContinuityState state;
    state.sealDamage(9'000'000);
    check(state.phase() == VideoContinuityPhase::DamageSealed,
          "damage did not seal the valid prefix first");
    state.freeze();
    state.noteAacFrontier(10'000'000);
    state.noteFrozenThrough(10'000'000);
    check(state.observePreferred(10'100'000, true, false) ==
              PreferredContinuityDecision::Discard &&
              state.phase() == VideoContinuityPhase::PreferredCandidate,
          "the first clean RAP was not observed as a candidate GOP");
    check(state.observePreferred(10'300'000, true, true) ==
              PreferredContinuityDecision::CandidateRejected &&
              state.phase() == VideoContinuityPhase::Frozen,
          "damage inside the candidate did not resume frozen output");
    check(state.snapshot().frozen_through_us == 10'000'000,
          "candidate rejection discarded the frozen frontier");
}

void test_next_rap_after_complete_candidate_restores() {
    VideoContinuityState state;
    state.sealDamage(9'000'000);
    state.freeze();
    state.observePreferred(10'000'000, true, false);
    check(state.observePreferred(10'033'367, false, false) ==
              PreferredContinuityDecision::Discard,
          "candidate media escaped before the next RAP");
    check(state.observePreferred(11'000'000, true, false) ==
              PreferredContinuityDecision::Restore &&
              state.phase() == VideoContinuityPhase::Restoring,
          "the RAP after one clean GOP did not start restoration");
    state.completeRestoration();
    check(state.phase() == VideoContinuityPhase::Normal,
          "committed restoration did not return to normal");
}

void test_fallback_is_video_only_state() {
    VideoContinuityState state;
    state.sealDamage(4'000'000);
    state.awaitFallback(0xf301);
    check(state.phase() == VideoContinuityPhase::FallbackPending &&
              state.snapshot().fallback_track_id == 0xf301,
          "covering rainfall did not enter fallback-pending");
    state.reset();
    check(state.phase() == VideoContinuityPhase::Normal &&
              !state.snapshot().damage_start_us,
          "reposition retained a false source-damage episode");
}

} // namespace

int main() {
    test_repeated_candidate_damage_keeps_frozen_continuity();
    test_next_rap_after_complete_candidate_restores();
    test_fallback_is_video_only_state();
    std::cout << "Video continuity state tests passed\n";
}
