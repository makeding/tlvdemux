#pragma once

#include <aribtlv/types.hpp>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <vector>

namespace tlvdemux::detail::mse {

class VideoAccessUnitHistory {
public:
    void push(const aribtlv::AccessUnit& unit);
    std::vector<aribtlv::AccessUnit> take_from(
        std::uint64_t track_id, std::int64_t earliest_presentation_time_us);
    void clear() noexcept;

private:
    struct CachedUnit {
        aribtlv::AccessUnit unit;
        std::int64_t presentation_time_us = 0;
        bool irap = false;
    };

    struct TrackHistory {
        std::deque<CachedUnit> units;
        std::size_t bytes = 0;
    };

    std::map<std::uint64_t, TrackHistory> tracks_;
};

} // namespace tlvdemux::detail::mse
