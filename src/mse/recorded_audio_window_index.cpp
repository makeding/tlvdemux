#include "recorded_audio_window_index.hpp"

#include <algorithm>
#include <limits>

namespace tlvdemux::detail::mse {

void RecordedAudioWindowIndex::reset() noexcept {
    selected_track_.reset();
    tracks_.clear();
}

void RecordedAudioWindowIndex::selectTrack(
    const std::optional<std::uint64_t> track_id) noexcept {
    selected_track_ = track_id;
}

bool RecordedAudioWindowIndex::observe(const aribtlv::AccessUnit& unit) {
    if (unit.codec != aribtlv::Codec::AacLatm || unit.pts.timescale <= 1 ||
        (selected_track_ && unit.track_id != *selected_track_)) return false;
    if (!selected_track_) selected_track_ = unit.track_id;
    const auto pts_us = unit.pts.value * 1000000 /
        static_cast<std::int64_t>(unit.pts.timescale);
    auto& anchors = tracks_[unit.track_id];
    if (!anchors.empty()) {
        if (pts_us < anchors.back().presentation_time_us) return false;
        if (!unit.discontinuity &&
            pts_us - anchors.back().presentation_time_us < kWindowDurationUs) return true;
    }
    anchors.push_back(RecordedAudioAnchor{
        unit.track_id, pts_us, unit.restart_offset, unit.input_offset,
    });
    return true;
}

const std::vector<RecordedAudioAnchor>& RecordedAudioWindowIndex::anchors() const noexcept {
    static const std::vector<RecordedAudioAnchor> empty;
    if (!selected_track_) return empty;
    const auto found = tracks_.find(*selected_track_);
    return found == tracks_.end() ? empty : found->second;
}

std::optional<RecordedAudioWindow> RecordedAudioWindowIndex::windowFor(
    const std::int64_t target_us) const {
    const auto& values = anchors();
    if (values.empty()) return std::nullopt;
    const auto after = std::upper_bound(
        values.begin(), values.end(), target_us,
        [](const std::int64_t target, const RecordedAudioAnchor& anchor) {
            return target < anchor.presentation_time_us;
        });
    if (after == values.begin()) return RecordedAudioWindow{*after, std::nullopt};
    const auto before = std::prev(after);
    return RecordedAudioWindow{
        *before, after == values.end()
            ? std::nullopt : std::optional<RecordedAudioAnchor>{*after},
    };
}

std::optional<std::uint64_t> RecordedAudioWindowIndex::estimateOffset(
    const std::int64_t target_us, const std::uint64_t source_size) const {
    const auto window = windowFor(target_us);
    if (!window) return std::nullopt;
    if (!window->second ||
        window->second->presentation_time_us <= window->first.presentation_time_us) {
        return std::min(window->first.restart_offset, source_size);
    }
    const auto span_us = window->second->presentation_time_us -
        window->first.presentation_time_us;
    const auto span_bytes = window->second->restart_offset -
        window->first.restart_offset;
    const auto offset_us = std::clamp<std::int64_t>(
        target_us - window->first.presentation_time_us, 0, span_us);
    const auto interpolated = static_cast<std::uint64_t>(
        static_cast<long double>(span_bytes) * static_cast<long double>(offset_us) /
        static_cast<long double>(span_us));
    const auto estimate = window->first.restart_offset +
        interpolated;
    return std::min(estimate, source_size);
}

} // namespace tlvdemux::detail::mse
