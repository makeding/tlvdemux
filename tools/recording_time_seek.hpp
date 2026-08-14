#pragma once

#include <aribtlv/recording.hpp>

#include <cstdint>
#include <iosfwd>
#include <string>

namespace tlvdemux::tools {

struct RecordingTimeSeek {
    std::uint64_t input_size = 0;
    std::int64_t first_pts_us = 0;
    std::int64_t last_pts_us = 0;
    std::int64_t target_pts_us = 0;
    aribtlv::SeekPoint point;
    std::size_t seek_point_count = 0;
};

RecordingTimeSeek locate_recording_time(const std::string& path,
                                        double seconds_from_start,
                                        std::ostream& diagnostics);

} // namespace tlvdemux::tools
