#include <tlvdemux/output_capabilities.hpp>

#include <cstdlib>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void test_generation_tracks_real_transitions() {
    tlvdemux::MseOutputStateTracker tracker;
    check(tracker.state().generation == 0, "initial generation is not zero");

    tlvdemux::MseOutputCapabilities capabilities;
    capabilities.edid_valid = true;
    capabilities.hlg_eotf = true;
    check(tracker.update(capabilities, true), "first capability update was ignored");
    check(tracker.state().generation == 1 && tracker.state().capabilities == capabilities,
          "capability update did not publish state");
    check(!tracker.update(capabilities, true), "identical capability update changed state");
    check(tracker.update(capabilities, false), "disconnect was not published");
    check(!tracker.state().connected && tracker.state().generation == 2,
          "disconnect state is incorrect");
    check(tracker.set_hdr_mode(tlvdemux::MseHdrOutputMode::Hlg),
          "HDR mode change was ignored");
    check(tracker.state().hdr_mode == tlvdemux::MseHdrOutputMode::Hlg &&
              tracker.state().generation == 3,
          "HDR mode state is incorrect");
    tlvdemux::MseDolbyTunnelCapabilities dolby;
    dolby.tunnel_supported = true;
    dolby.metadata_passthrough = true;
    dolby.observed_profile = 8;
    check(tracker.set_dolby_tunnel(dolby), "Dolby tunnel state was ignored");
    check(tracker.state().dolby_tunnel == dolby && tracker.state().generation == 4,
          "Dolby tunnel state is incorrect");
}

} // namespace

int main() {
    test_generation_tracks_real_transitions();
    std::cout << "output state tests passed\n";
}
