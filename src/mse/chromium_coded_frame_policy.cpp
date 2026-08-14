#include "chromium_coded_frame_policy.hpp"

namespace tlvdemux::detail::mse {

ChromiumCodedFrameDecision ChromiumCodedFramePolicy::process(
    const ChromiumCodedFrame& frame) noexcept {
    ChromiumFrameDiscontinuity discontinuity = ChromiumFrameDiscontinuity::None;
    if (last_decode_timestamp_.has_value() && last_frame_duration_.has_value()) {
        const auto delta = frame.decode_timestamp - *last_decode_timestamp_;
        if (delta < 0) {
            discontinuity = ChromiumFrameDiscontinuity::DecodeTimestampWentBackwards;
        } else if (delta > 2 * static_cast<std::int64_t>(*last_frame_duration_)) {
            discontinuity = ChromiumFrameDiscontinuity::DecodeTimestampGap;
        }
        if (discontinuity != ChromiumFrameDiscontinuity::None) reset();
    }

    if (needs_random_access_point_ && !frame.random_access) {
        return {false, false, discontinuity};
    }
    if (frame.duration == 0) return {false, false, discontinuity};

    const bool starts_group = starts_coded_frame_group_;
    needs_random_access_point_ = false;
    starts_coded_frame_group_ = false;
    last_decode_timestamp_ = frame.decode_timestamp;
    last_frame_duration_ = frame.duration;
    return {true, starts_group, discontinuity};
}

void ChromiumCodedFramePolicy::reset() noexcept {
    last_decode_timestamp_.reset();
    last_frame_duration_.reset();
    needs_random_access_point_ = true;
    starts_coded_frame_group_ = true;
}

} // namespace tlvdemux::detail::mse
