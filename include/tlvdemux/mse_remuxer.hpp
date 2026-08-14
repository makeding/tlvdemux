#pragma once

#include <aribtlv/types.hpp>
#include <tlvdemux/playback_damage.hpp>

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
    std::int64_t start_time_us = 0;
    std::int64_t end_time_us = 0;
};

struct MseAudioSplice {
    std::int64_t presentation_time_us = 0;
};

struct MseVideoSplice {
    std::int64_t presentation_time_us = 0;
};

struct MseLayerSwitch {
    std::uint64_t video_track_id = 0;
    std::uint64_t audio_track_id = 0;
    std::int64_t video_presentation_time_us = 0;
    std::int64_t audio_presentation_time_us = 0;
};

struct MseAutomaticLayerPair {
    std::uint64_t preferred_video_track_id = 0;
    std::uint64_t preferred_audio_track_id = 0;
    std::uint64_t fallback_video_track_id = 0;
    std::uint64_t fallback_audio_track_id = 0;
};

struct MseAutomaticLayerSwitchRequest {
    std::uint64_t video_track_id = 0;
    std::uint64_t audio_track_id = 0;
    std::int64_t earliest_presentation_time_us = 0;
};

enum class MseLayerSwitchCancelReason {
    EndOfInput,
    Reset,
    Reposition,
    SelectionChanged,
};

struct MseLayerSwitchCancelled {
    std::uint64_t video_track_id = 0;
    std::uint64_t audio_track_id = 0;
    std::uint64_t previous_video_track_id = 0;
    std::uint64_t previous_audio_track_id = 0;
    MseLayerSwitchCancelReason reason = MseLayerSwitchCancelReason::EndOfInput;
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
    virtual void onMseAudioSplice(const MseAudioSplice&) {}
    virtual void onMseVideoSplice(const MseVideoSplice&) {}
    virtual void onMseLayerSwitch(const MseLayerSwitch&) {}
    virtual void onMseLayerSwitchCancelled(const MseLayerSwitchCancelled&) {}
    virtual void onMseVideoStart(const MseVideoStart&) {}
    virtual void onPlaybackDamage(const PlaybackDamage&) {}
};

class MseRemuxer {
public:
    explicit MseRemuxer(MseSink& sink, MseOptions options = {});
    ~MseRemuxer();
    MseRemuxer(const MseRemuxer&) = delete;
    MseRemuxer& operator=(const MseRemuxer&) = delete;

    std::optional<MseLayerSwitchCancelled> selectTrack(
        TrackKind kind, std::optional<std::uint64_t> track_id);
    std::optional<std::int64_t> switchAudioTrack(
        std::uint64_t track_id, std::int64_t earliest_presentation_time_us);
    bool switchLayer(std::uint64_t video_track_id, std::uint64_t audio_track_id,
                     std::int64_t earliest_presentation_time_us);
    void configureAutomaticLayerSwitch(MseAutomaticLayerPair pair);
    void clearAutomaticLayerSwitch();
    void setOutputEnabled(bool enabled);
    std::optional<MseAutomaticLayerSwitchRequest> push(const AccessUnit& unit);
    void observeDamage(const aribtlv::DamageSpan& damage);
    void flush();
    std::optional<MseLayerSwitchCancelled> endOfStream();
    std::optional<MseLayerSwitchCancelled> reset();
    std::optional<MseLayerSwitchCancelled> reposition();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace tlvdemux
