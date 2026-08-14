#include "recording_time_seek.hpp"

#include <aribtlv/demuxer.hpp>

#include <array>
#include <cmath>
#include <fstream>
#include <limits>
#include <optional>
#include <stdexcept>

namespace tlvdemux::tools {
namespace {

constexpr std::size_t read_size = 1024 * 1024;
constexpr std::uint64_t progress_interval = 512ULL * 1024ULL * 1024ULL;

std::optional<std::int64_t> microseconds(const aribtlv::Timestamp timestamp) {
    if (timestamp.timescale == 0) return std::nullopt;
    const auto scale = static_cast<std::int64_t>(timestamp.timescale);
    const auto whole = timestamp.value / scale;
    const auto remainder = timestamp.value % scale;
    constexpr std::int64_t factor = 1000000;
    if (whole > std::numeric_limits<std::int64_t>::max() / factor ||
        whole < std::numeric_limits<std::int64_t>::min() / factor) {
        return std::nullopt;
    }
    return whole * factor + remainder * factor / scale;
}

class IndexSink final : public aribtlv::Sink {
public:
    IndexSink() { index_.begin(false); }

    void onService(const aribtlv::ServiceInfo&) override {}

    void onTrack(const aribtlv::TrackInfo& track) override {
        if (track_id_.has_value() || track.kind != aribtlv::TrackKind::Video ||
            track.codec != aribtlv::Codec::Hevc) {
            return;
        }
        track_id_ = track.track_id;
        index_.selectVideoTrack(track_id_);
    }

    void onAccessUnit(aribtlv::AccessUnit&& unit) override {
        if (track_id_ != unit.track_id) return;
        const auto pts = microseconds(unit.pts);
        if (!pts.has_value()) return;
        if (!first_pts_.has_value() || *pts < *first_pts_) first_pts_ = *pts;
        if (!last_pts_.has_value() || *pts > *last_pts_) last_pts_ = *pts;
        index_.observe(unit);
    }

    void onError(const aribtlv::Error& error) override {
        if (!error.recoverable) ++fatal_errors_;
    }

    RecordingTimeSeek finish(const std::uint64_t input_size,
                             const double seconds_from_start) {
        if (!index_.finalize() || !first_pts_.has_value() || !last_pts_.has_value()) {
            throw std::runtime_error("recording scan did not produce a complete video index");
        }
        const long double delta = static_cast<long double>(seconds_from_start) * 1000000.0L;
        if (!std::isfinite(seconds_from_start) || seconds_from_start < 0.0 ||
            delta > static_cast<long double>(std::numeric_limits<std::int64_t>::max()) -
                static_cast<long double>(*first_pts_)) {
            throw std::runtime_error("target time is outside the supported range");
        }
        const auto target_pts_us = *first_pts_ + static_cast<std::int64_t>(delta);
        const auto point = index_.previousSync({target_pts_us, 1000000});
        if (!point.has_value()) {
            throw std::runtime_error("no random-access point precedes the target time");
        }
        if (fatal_errors_ != 0) {
            throw std::runtime_error("recording scan encountered a fatal demux error");
        }
        return {input_size, *first_pts_, *last_pts_, target_pts_us, *point,
                index_.seekPoints().size()};
    }

private:
    aribtlv::RecordingIndex index_;
    std::optional<std::uint64_t> track_id_;
    std::optional<std::int64_t> first_pts_;
    std::optional<std::int64_t> last_pts_;
    std::size_t fatal_errors_ = 0;
};

} // namespace

RecordingTimeSeek locate_recording_time(const std::string& path,
                                        const double seconds_from_start,
                                        std::ostream& diagnostics) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open " + path);
    const auto end = input.tellg();
    if (end <= 0) throw std::runtime_error("empty input " + path);
    const auto input_size = static_cast<std::uint64_t>(end);
    input.seekg(0, std::ios::beg);

    IndexSink sink;
    aribtlv::Limits limits;
    limits.collect_application_resources = false;
    aribtlv::Demuxer demuxer(sink, limits);
    std::array<std::uint8_t, read_size> buffer{};
    std::uint64_t consumed = 0;
    std::uint64_t next_progress = progress_interval;
    while (input) {
        input.read(reinterpret_cast<char*>(buffer.data()),
                   static_cast<std::streamsize>(buffer.size()));
        const auto count = input.gcount();
        if (count <= 0) break;
        demuxer.push(buffer.data(), static_cast<std::size_t>(count));
        consumed += static_cast<std::uint64_t>(count);
        if (consumed >= next_progress) {
            diagnostics << "target-index-progress bytes=" << consumed
                        << " of=" << input_size << '\n';
            next_progress += progress_interval;
        }
    }
    demuxer.flush();
    return sink.finish(input_size, seconds_from_start);
}

} // namespace tlvdemux::tools
