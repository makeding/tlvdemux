#pragma once

#include <aribtlv/types.hpp>

#include <cstdint>
#include <map>
#include <optional>
#include <vector>

namespace tlvdemux::detail::mse {

struct RecordedAudioAnchor {
    std::uint64_t track_id = 0;
    std::int64_t presentation_time_us = 0;
    std::uint64_t restart_offset = 0;
    std::uint64_t input_offset = 0;
};

struct RecordedAudioWindow {
    RecordedAudioAnchor first;
    std::optional<RecordedAudioAnchor> second;
};

class RecordedAudioWindowIndex {
public:
    void reset() noexcept;
    void selectTrack(std::optional<std::uint64_t> track_id) noexcept;
    bool observe(const aribtlv::AccessUnit& unit);
    std::optional<RecordedAudioWindow> windowFor(std::int64_t target_us) const;
    std::optional<std::uint64_t> estimateOffset(
        std::int64_t target_us, std::uint64_t source_size) const;
    const std::vector<RecordedAudioAnchor>& anchors() const noexcept;

private:
    static constexpr std::int64_t kWindowDurationUs = 2000000;
    std::optional<std::uint64_t> selected_track_;
    std::map<std::uint64_t, std::vector<RecordedAudioAnchor>> tracks_;
};

} // namespace tlvdemux::detail::mse
