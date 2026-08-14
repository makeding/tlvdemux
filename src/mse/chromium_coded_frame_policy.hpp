#pragma once

#include <cstdint>
#include <optional>

namespace tlvdemux::detail::mse {

// Mirrors the discontinuity and random-access-point portion of Chromium's
// Media Source coded frame processing algorithm. The adapted source is covered
// by third_party/chromium/LICENSE.
enum class ChromiumFrameDiscontinuity {
    None,
    DecodeTimestampWentBackwards,
    DecodeTimestampGap,
};

struct ChromiumCodedFrame {
    std::int64_t decode_timestamp = 0;
    std::uint32_t duration = 0;
    bool random_access = false;
};

struct ChromiumCodedFrameDecision {
    bool append = false;
    bool starts_coded_frame_group = false;
    ChromiumFrameDiscontinuity discontinuity = ChromiumFrameDiscontinuity::None;
};

class ChromiumCodedFramePolicy {
public:
    ChromiumCodedFrameDecision process(const ChromiumCodedFrame&) noexcept;
    void reset() noexcept;

    bool needsRandomAccessPoint() const noexcept { return needs_random_access_point_; }

private:
    std::optional<std::int64_t> last_decode_timestamp_;
    std::optional<std::uint32_t> last_frame_duration_;
    bool needs_random_access_point_ = true;
    bool starts_coded_frame_group_ = true;
};

} // namespace tlvdemux::detail::mse
