#pragma once

#include <aribtlv/recording.hpp>

#include <cstdint>
#include <iosfwd>
#include <optional>
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

struct RecordingTimeSeekOptions {
    std::optional<std::uint32_t> service_context_id;
    std::optional<std::uint16_t> video_packet_id;
};

struct RecordingTimeSeekIndex {
    std::uint64_t input_size = 0;
    std::int64_t first_pts_us = 0;
    std::int64_t last_pts_us = 0;
    std::size_t seek_point_count = 0;
    aribtlv::RecordingScanner scanner;
};

RecordingTimeSeekIndex build_recording_time_seek_index(
    const std::string& path,
    std::ostream& diagnostics,
    RecordingTimeSeekOptions options = {});

RecordingTimeSeek locate_recording_time(const RecordingTimeSeekIndex& index,
                                        double seconds_from_start);

RecordingTimeSeek locate_recording_time(const std::string& path,
                                        double seconds_from_start,
                                        std::ostream& diagnostics,
                                        RecordingTimeSeekOptions options = {});

} // namespace tlvdemux::tools
