#include "recording_time_seek.hpp"

#include <array>
#include <cmath>
#include <fstream>
#include <limits>
#include <stdexcept>

namespace tlvdemux::tools {
namespace {

constexpr std::size_t read_size = 1024 * 1024;
constexpr std::uint64_t progress_interval = 512ULL * 1024ULL * 1024ULL;

const char* scan_failure_message(const aribtlv::RecordingScanFailure failure) {
    switch (failure) {
    case aribtlv::RecordingScanFailure::None: return "none";
    case aribtlv::RecordingScanFailure::SourceError: return "input read failed";
    case aribtlv::RecordingScanFailure::NoVideo: return "selected video was not found";
    case aribtlv::RecordingScanFailure::NoRandomAccessPoint:
        return "selected video has no random-access point";
    case aribtlv::RecordingScanFailure::ParseError: return "fatal demux error";
    }
    return "unknown scan failure";
}

} // namespace

RecordingTimeSeek locate_recording_time(const std::string& path,
                                        const double seconds_from_start,
                                        std::ostream& diagnostics,
                                        RecordingTimeSeekOptions options) {
    auto index = build_recording_time_seek_index(path, diagnostics, options);
    return locate_recording_time(index, seconds_from_start);
}

RecordingTimeSeekIndex build_recording_time_seek_index(
    const std::string& path,
    std::ostream& diagnostics,
    RecordingTimeSeekOptions options) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open " + path);
    const auto end = input.tellg();
    if (end <= 0) throw std::runtime_error("empty input " + path);
    const auto input_size = static_cast<std::uint64_t>(end);
    input.seekg(0, std::ios::beg);

    RecordingTimeSeekIndex result;
    result.input_size = input_size;
    result.scanner = aribtlv::RecordingScanner({options.service_context_id,
                                                 options.video_packet_id});
    std::array<std::uint8_t, read_size> buffer{};
    std::uint64_t consumed = 0;
    std::uint64_t next_progress = progress_interval;
    while (input) {
        input.read(reinterpret_cast<char*>(buffer.data()),
                   static_cast<std::streamsize>(buffer.size()));
        const auto count = input.gcount();
        if (count <= 0) break;
        if (!result.scanner.push(buffer.data(), static_cast<std::size_t>(count))) break;
        consumed += static_cast<std::uint64_t>(count);
        if (consumed >= next_progress) {
            diagnostics << "target-index-progress bytes=" << consumed
                        << " of=" << input_size << '\n';
            next_progress += progress_interval;
        }
    }
    if (!input.eof()) result.scanner.failSource();
    const auto& scan = result.scanner.finish();
    if (!scan.complete()) {
        std::string message = scan_failure_message(scan.failure);
        if (scan.error && !scan.error->message.empty()) message += ": " + scan.error->message;
        throw std::runtime_error("recording scan failed: " + message);
    }
    if (!scan.first_presentation_time || !scan.last_presentation_time) {
        throw std::runtime_error("recording scan has no presentation timeline");
    }
    result.first_pts_us = scan.first_presentation_time->value;
    result.last_pts_us = scan.last_presentation_time->value;
    result.seek_point_count = scan.seek_points.size();
    return result;
}

RecordingTimeSeek locate_recording_time(const RecordingTimeSeekIndex& index,
                                        const double seconds_from_start) {
    const long double delta = static_cast<long double>(seconds_from_start) * 1000000.0L;
    if (!std::isfinite(seconds_from_start) || seconds_from_start < 0.0 ||
        delta > static_cast<long double>(std::numeric_limits<std::int64_t>::max())) {
        throw std::runtime_error("target time is outside the supported range");
    }
    const auto found = index.scanner.seekFromStart(
        {static_cast<std::int64_t>(delta), 1000000});
    if (!found) throw std::runtime_error("target time is outside the recording timeline");
    return {
        index.input_size,
        index.first_pts_us,
        index.last_pts_us,
        found->target_presentation_time.value,
        found->point,
        index.seek_point_count,
    };
}

} // namespace tlvdemux::tools
