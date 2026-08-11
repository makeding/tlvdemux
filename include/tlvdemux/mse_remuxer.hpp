#pragma once

#include <aribtlv/types.hpp>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux {

using aribtlv::AccessUnit;
using aribtlv::Codec;
using aribtlv::TrackKind;

struct MseTrackInit {
    std::string type;
    std::string mime;
    std::vector<std::uint8_t> data;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t sample_rate = 0;
    std::uint32_t channels = 0;
};

struct MseMediaSegment {
    std::string type;
    std::vector<std::uint8_t> data;
};

struct MseVideoStart {
    int nal_type = -1;
    bool signalled_random_access = false;
};

enum class MseOutputMode {
    SeparateTracks,
    Multiplexed,
};

struct MseOptions {
    // Zero preserves all audio configurations. A non-zero value prevents the
    // remuxer from emitting an init segment for AAC layouts above this limit.
    std::uint32_t max_audio_channels = 0;
    // Multiplexed emits one fragmented MP4 stream containing one video and
    // one audio track. SeparateTracks preserves the browser/MSE callbacks.
    MseOutputMode output_mode = MseOutputMode::SeparateTracks;
};

class MseSink {
public:
    virtual ~MseSink() = default;
    virtual void onMseInit(MseTrackInit&&) = 0;
    virtual void onMseSegment(MseMediaSegment&&) = 0;
    virtual void onMseVideoStart(const MseVideoStart&) {}
};

class MseRemuxer {
public:
    explicit MseRemuxer(MseSink& sink, MseOptions options = {});
    ~MseRemuxer();
    MseRemuxer(const MseRemuxer&) = delete;
    MseRemuxer& operator=(const MseRemuxer&) = delete;

    void selectTrack(TrackKind kind, std::optional<std::uint64_t> track_id);
    void setOutputEnabled(bool enabled) noexcept;
    void push(const AccessUnit& unit);
    void flush();
    void reset();
    void reposition();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace tlvdemux
