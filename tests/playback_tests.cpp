#include <tlvdemux/playback.hpp>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {

[[noreturn]] void fail(const std::string& message) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void check(const bool condition, const std::string& message) {
    if (!condition) fail(message);
}

void test_seek_policy_selection() {
    tlvdemux::SourceCapabilities range;
    range.random_access = true;
    range.size_known = true;
    check(tlvdemux::chooseSeekPolicy(range, true, false) ==
              tlvdemux::SeekPolicy::IndexedRandomAccess,
          "usable random-access index did not select indexed seeking");
    check(tlvdemux::chooseSeekPolicy(range, false, false) ==
              tlvdemux::SeekPolicy::AdaptiveRangeProbe,
          "unindexed random-access source did not select adaptive probing");

    tlvdemux::SourceCapabilities sequential;
    check(tlvdemux::chooseSeekPolicy(sequential, false, true) ==
              tlvdemux::SeekPolicy::BufferedOnly,
          "sequential buffered source did not select buffered seeking");
    check(tlvdemux::chooseSeekPolicy(sequential, false, false) ==
              tlvdemux::SeekPolicy::Unsupported,
          "sequential unbuffered source claimed seek support");
}

void test_playback_state_machine() {
    tlvdemux::SourceCapabilities capabilities;
    capabilities.random_access = true;
    capabilities.size_known = true;
    capabilities.growing = true;
    const auto policy = tlvdemux::chooseSeekPolicy(capabilities, false, false);

    tlvdemux::PlaybackStateMachine state;
    check(state.beginOpen(capabilities, policy) &&
              state.sessionState() == tlvdemux::SessionState::Opening,
          "session did not enter Opening");
    const auto session = state.sessionId();
    check(state.completeOpen() && state.sessionState() == tlvdemux::SessionState::Ready,
          "session did not enter Ready");
    check(state.startIndexBuilding() &&
              state.indexState() == tlvdemux::IndexState::Building,
          "index did not start building");
    check(state.reachIndexEnd(true) &&
              state.indexState() == tlvdemux::IndexState::Following,
          "growing index did not enter Following");
    check(state.reachGrowingEnd() &&
              state.sessionState() == tlvdemux::SessionState::WaitingForData,
          "growing source EOF did not enter WaitingForData");
    check(state.sourceGrew() && state.sessionState() == tlvdemux::SessionState::Ready &&
              state.indexState() == tlvdemux::IndexState::Building,
          "source growth did not resume session and index");
    check(state.reachIndexEnd(true), "following index did not reach readable end again");
    check(state.sourceFinalized(false) &&
              state.indexState() == tlvdemux::IndexState::Complete,
          "source finalization did not complete the following index");
    check(state.reachFinalEnd() && state.sessionState() == tlvdemux::SessionState::Ended,
          "final EOF did not enter Ended");

    const auto first_seek = state.requestSeek();
    check(first_seek.has_value() && state.sessionState() == tlvdemux::SessionState::Ready &&
              state.seekState() == tlvdemux::SeekState::Resolving,
          "seek from Ended did not reopen the session transaction");
    check(state.beginReposition(*first_seek) && state.beginPriming(*first_seek) &&
              state.beginPreroll(*first_seek) && state.beginLanding(*first_seek) &&
              state.completeSeek(*first_seek),
          "exact-seek state path was rejected");
    check(state.accepts(session, *first_seek),
          "current session/generation was not accepted after landing");

    const auto old_seek = state.requestSeek();
    const auto new_seek = state.requestSeek();
    check(old_seek.has_value() && new_seek.has_value() && *new_seek > *old_seek,
          "new seek did not advance the generation");
    check(!state.beginReposition(*old_seek) && state.beginReposition(*new_seek),
          "stale seek generation changed state");
    check(state.failSeek(*new_seek) && state.finishFailedSeek(*new_seek),
          "recoverable seek failure did not return to Idle");
    check(state.close() && !state.accepts(session, *new_seek),
          "close did not invalidate outstanding operations");

    capabilities.growing = false;
    check(state.beginOpen(capabilities, policy) && state.completeOpen(),
          "state machine could not open a second session");
    const auto failed_session = state.sessionId();
    const auto failed_generation = state.seekGeneration();
    check(state.failSession() && state.sessionState() == tlvdemux::SessionState::Failed &&
              !state.accepts(failed_session, failed_generation) &&
              !state.requestSeek().has_value() && !state.startIndexBuilding(),
          "fatal session failure was not sticky");
    check(state.close(), "failed session could not be closed");
}

void test_stream_event_timing() {
    const auto ntp = [](const std::uint64_t seconds) { return seconds << 32U; };
    const auto target_is = [](const tlvdemux::StreamEventTiming& timing,
                              const std::int64_t microseconds) {
        return timing.target_time.has_value() &&
            timing.target_time->value == microseconds &&
            timing.target_time->timescale == 1000000;
    };
    tlvdemux::StreamEvent event;

    event.time_mode = 0;
    auto timing = tlvdemux::resolveStreamEventTiming(event, true);
    check(timing.domain == tlvdemux::StreamEventClockDomain::Immediate &&
              !timing.target_time.has_value(),
          "immediate EMT event acquired a target clock");

    event.time_mode = 1;
    event.time_value = ntp(200);
    timing = tlvdemux::resolveStreamEventTiming(event, true);
    check(timing.domain == tlvdemux::StreamEventClockDomain::PlaybackUtc &&
              target_is(timing, 200000000),
          "mode-1 EMT event did not retain the playback wall-clock domain");

    const tlvdemux::BroadcastClock clock{
        tlvdemux::Timestamp{10000000, 1000000},
        tlvdemux::Timestamp{100000000, 1000000}, 0, false};
    event.time_mode = 5;
    event.time_value = ntp(103);
    timing = tlvdemux::resolveStreamEventTiming(event, true, clock);
    check(timing.domain == tlvdemux::StreamEventClockDomain::MediaTimeline &&
              target_is(timing, 13000000),
          "mode-5 recorded EMT event did not use original broadcast time");
    timing = tlvdemux::resolveStreamEventTiming(event, false, clock);
    check(timing.domain == tlvdemux::StreamEventClockDomain::PlaybackUtc &&
              target_is(timing, 103000000),
          "mode-5 live EMT event did not use the wall clock");

    event.time_mode = 2;
    event.utc_reference = ntp(100);
    event.npt_reference = ntp(20);
    event.time_value = ntp(22);
    timing = tlvdemux::resolveStreamEventTiming(event, true, clock);
    check(timing.domain == tlvdemux::StreamEventClockDomain::MediaTimeline &&
              target_is(timing, 12000000),
          "NPT EMT event was not projected through UTC onto media time");

    event.time_mode = 3;
    event.time_value = ntp(3);
    timing = tlvdemux::resolveStreamEventTiming(
        event, true, std::nullopt, tlvdemux::Timestamp{5000000, 1000000});
    check(timing.domain == tlvdemux::StreamEventClockDomain::MediaTimeline &&
              target_is(timing, 8000000),
          "programme-relative EMT event did not use programme media start");

    event.time_mode = 4;
    timing = tlvdemux::resolveStreamEventTiming(event, true);
    check(timing.domain == tlvdemux::StreamEventClockDomain::Unsupported,
          "reserved EMT time mode was accepted");
}

} // namespace

int main() {
    test_seek_policy_selection();
    test_playback_state_machine();
    test_stream_event_timing();
    std::cout << "all playback tests passed\n";
    return 0;
}
