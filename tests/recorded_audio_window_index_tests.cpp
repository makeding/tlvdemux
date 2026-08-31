#include "mse/recorded_audio_window_index.hpp"

#include <aribtlv/types.hpp>

#include <cstdlib>
#include <iostream>

namespace {

void check(const bool condition, const char* message) {
    if (!condition) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

aribtlv::AccessUnit audio(const std::int64_t pts_us, const std::uint64_t offset,
                          const std::uint64_t track = 7) {
    aribtlv::AccessUnit unit;
    unit.codec = aribtlv::Codec::AacLatm;
    unit.track_id = track;
    unit.pts = {pts_us, 1000000};
    unit.dts = unit.pts;
    unit.restart_offset = offset > 16 ? offset - 16 : 0;
    unit.input_offset = offset;
    return unit;
}

} // namespace

int main() {
    tlvdemux::detail::mse::RecordedAudioWindowIndex index;
    index.selectTrack(7);
    check(index.observe(audio(0, 100)), "first AAC anchor was rejected");
    check(index.observe(audio(1000000, 200)), "AAC inside a window was rejected");
    check(index.observe(audio(2000000, 300)), "second AAC window anchor was rejected");
    check(index.observe(audio(4000000, 500)), "third AAC window anchor was rejected");
    check(index.anchors().size() == 3, "AAC anchors were not sampled at two-second windows");
    const auto window = index.windowFor(3000000);
    check(window && window->first.presentation_time_us == 2000000 &&
              window->second && window->second->presentation_time_us == 4000000,
          "target did not resolve through its surrounding AAC anchors");
    const auto estimate = index.estimateOffset(3000000, 1000);
    check(estimate && *estimate == 384,
          "AAC-window offset interpolation did not use restart offsets");
    index.selectTrack(8);
    check(index.observe(audio(0, 900, 7)) == false,
          "an unselected AAC track polluted the canonical timeline");
    check(index.observe(audio(0, 600, 8)), "selected replacement AAC track was rejected");
    check(index.windowFor(0)->first.track_id == 8,
          "audio track selection did not replace the canonical anchor timeline");
    std::cout << "Recorded AAC window index tests passed\n";
}
