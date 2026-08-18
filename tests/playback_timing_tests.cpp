#include <tlvdemux/playback_timing.hpp>

#include <cstdlib>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void test_pts_events() {
    tlvdemux::PlaybackTimingDiagnostics diagnostics;
    check(!diagnostics.observe_pts(7, 1'000'000), "first PTS emitted an event");
    const auto jump = diagnostics.observe_pts(7, 1'600'000);
    check(jump.has_value() && jump->kind == tlvdemux::PlaybackTimingEventKind::PtsJump &&
              jump->recommended_preroll_us == 250'000,
          "PTS jump was not diagnosed");
    const auto regression = diagnostics.observe_pts(7, 1'500'000);
    check(regression.has_value() &&
              regression->kind == tlvdemux::PlaybackTimingEventKind::PtsRegression,
          "PTS regression was not diagnosed");
    diagnostics.reset();
    check(!diagnostics.observe_pts(7, 10), "reset did not clear PTS history");
}

void test_underrun_event() {
    tlvdemux::PlaybackTimingDiagnostics diagnostics;
    check(!diagnostics.observe_buffer(7, 2'000'000, 2'100'000),
          "healthy buffer emitted underrun");
    const auto underrun = diagnostics.observe_buffer(7, 2'000'000, 1'900'000);
    check(underrun.has_value() &&
              underrun->kind == tlvdemux::PlaybackTimingEventKind::Underrun &&
              underrun->recommended_preroll_us == 250'000,
          "buffer underrun was not diagnosed");
}

} // namespace

int main() {
    test_pts_events();
    test_underrun_event();
    std::cout << "playback timing tests passed\n";
}
