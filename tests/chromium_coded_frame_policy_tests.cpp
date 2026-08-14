#include "mse/chromium_coded_frame_policy.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using tlvdemux::detail::mse::ChromiumCodedFrame;
using tlvdemux::detail::mse::ChromiumCodedFramePolicy;
using tlvdemux::detail::mse::ChromiumFrameDiscontinuity;

void check(const bool condition, const std::string& message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void test_initial_frames_wait_for_random_access() {
    ChromiumCodedFramePolicy policy;
    check(!policy.process({0, 1000, false}).append,
          "initial non-RAP frame was accepted");
    const auto rap = policy.process({1000, 1000, true});
    check(rap.append && rap.starts_coded_frame_group,
          "initial RAP did not start a coded frame group");
    check(policy.process({2000, 1000, false}).append,
          "frame following the initial RAP was dropped");
}

void test_large_gap_restarts_at_random_access() {
    ChromiumCodedFramePolicy policy;
    check(policy.process({0, 1000, true}).append, "initial RAP was rejected");
    const auto dropped = policy.process({3001, 1000, false});
    check(!dropped.append &&
              dropped.discontinuity == ChromiumFrameDiscontinuity::DecodeTimestampGap,
          "a DTS delta larger than twice the previous duration was not rejected");
    const auto rap = policy.process({4000, 1000, true});
    check(rap.append && rap.starts_coded_frame_group,
          "RAP after a DTS gap did not restart the coded frame group");
}

void test_exact_double_duration_is_continuous() {
    ChromiumCodedFramePolicy policy;
    check(policy.process({0, 1000, true}).append, "initial RAP was rejected");
    const auto boundary = policy.process({2000, 1000, false});
    check(boundary.append &&
              boundary.discontinuity == ChromiumFrameDiscontinuity::None,
          "Chromium's strict greater-than discontinuity threshold changed");
}

void test_backwards_dts_waits_for_random_access() {
    ChromiumCodedFramePolicy policy;
    check(policy.process({1000, 1000, true}).append, "initial RAP was rejected");
    const auto dropped = policy.process({999, 1000, false});
    check(!dropped.append && dropped.discontinuity ==
              ChromiumFrameDiscontinuity::DecodeTimestampWentBackwards,
          "backwards DTS did not reset the coded frame group");
}

} // namespace

int main() {
    test_initial_frames_wait_for_random_access();
    test_large_gap_restarts_at_random_access();
    test_exact_double_duration_is_continuous();
    test_backwards_dts_waits_for_random_access();
    std::cout << "chromium coded frame policy tests passed\n";
}
