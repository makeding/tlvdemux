#include "video_access_unit_history.hpp"

#include "hevc_parser.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <map>
#include <utility>

namespace tlvdemux::detail::mse {
namespace {

constexpr std::int64_t kHistoryDurationUs = 20000000;
constexpr std::size_t kHistoryBytesPerTrack = 64U * 1024U * 1024U;

std::int64_t presentation_time_us(const aribtlv::AccessUnit& unit) {
    return unit.pts.value * 1000000 / static_cast<std::int64_t>(unit.pts.timescale);
}

void append_annex_b(Bytes& destination, const Bytes& nalu) {
    destination.insert(destination.end(), {0, 0, 0, 1});
    destination.insert(destination.end(), nalu.begin(), nalu.end());
}

} // namespace

void VideoAccessUnitHistory::push(const aribtlv::AccessUnit& unit) {
    if (unit.codec != aribtlv::Codec::Hevc || unit.pts.timescale <= 1 ||
        unit.dts.timescale <= 1) return;
    const auto nalus = annex_b_views(unit.data);
    const bool irap = std::any_of(nalus.begin(), nalus.end(), [](const NaluView& nalu) {
        return nalu.type >= 16 && nalu.type <= 21;
    });
    auto& history = tracks_[unit.track_id];
    const auto timestamp = presentation_time_us(unit);
    history.bytes += unit.data.size();
    history.units.push_back(CachedUnit{unit, timestamp, irap});
    while (!history.units.empty() &&
           (timestamp - history.units.front().presentation_time_us > kHistoryDurationUs ||
            history.bytes > kHistoryBytesPerTrack)) {
        history.bytes -= history.units.front().unit.data.size();
        history.units.pop_front();
    }
}

std::vector<aribtlv::AccessUnit> VideoAccessUnitHistory::take_from(
    const std::uint64_t track_id, const std::int64_t earliest_presentation_time_us) {
    const auto track = tracks_.find(track_id);
    if (track == tracks_.end()) return {};
    auto history = std::move(track->second);
    tracks_.erase(track);
    const auto first = std::find_if(history.units.begin(), history.units.end(),
        [earliest_presentation_time_us](const CachedUnit& cached) {
            return cached.irap &&
                cached.presentation_time_us >= earliest_presentation_time_us;
        });
    if (first == history.units.end()) return {};

    std::map<int, Bytes> parameter_sets;
    for (auto iterator = history.units.begin(); iterator != std::next(first); ++iterator) {
        for (const auto& nalu : annex_b_views(iterator->unit.data)) {
            if (nalu.type >= 32 && nalu.type <= 34) {
                parameter_sets[nalu.type] = copy_nalu(iterator->unit.data, nalu);
            }
        }
    }
    if (parameter_sets.size() != 3) return {};

    std::vector<aribtlv::AccessUnit> replay;
    replay.reserve(static_cast<std::size_t>(std::distance(first, history.units.end())));
    replay.push_back(first->unit);
    Bytes configured;
    for (const auto type : std::array{32, 33, 34}) {
        append_annex_b(configured, parameter_sets.at(type));
    }
    configured.insert(configured.end(), replay.front().data.begin(), replay.front().data.end());
    replay.front().data = std::move(configured);
    for (auto iterator = std::next(first); iterator != history.units.end(); ++iterator) {
        replay.push_back(iterator->unit);
    }
    return replay;
}

void VideoAccessUnitHistory::clear() noexcept { tracks_.clear(); }

} // namespace tlvdemux::detail::mse
