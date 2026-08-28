#pragma once

#include <aribtlv/types.hpp>

#include <tlvdemux/mse_remuxer.hpp>

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>

#include <emscripten/val.h>

class WasmMseRemuxer {
public:
    using LayerSwitchCancellationHandler =
        std::function<void(const tlvdemux::MseLayerSwitchCancelled&)>;

    explicit WasmMseRemuxer(emscripten::val callbacks,
                            std::uint32_t max_audio_channels = 0,
                            LayerSwitchCancellationHandler cancellation_handler = {});
    ~WasmMseRemuxer();
    WasmMseRemuxer(const WasmMseRemuxer&) = delete;
    WasmMseRemuxer& operator=(const WasmMseRemuxer&) = delete;

    std::optional<tlvdemux::MseLayerSwitchCancelled> selectTrack(
        aribtlv::TrackKind kind, std::optional<std::uint64_t> track_id);
    std::optional<std::int64_t> switchAudioTrack(
        std::uint64_t track_id, std::int64_t earliest_presentation_time_us);
    bool switchLayer(std::uint64_t video_track_id, std::uint64_t audio_track_id,
                     std::int64_t earliest_presentation_time_us);
    bool switchLayerAtPlaybackEntry(std::uint64_t video_track_id,
                                    std::uint64_t audio_track_id,
                                    std::int64_t playback_entry_time_us);
    void configureAutomaticLayerSwitch(tlvdemux::MseAutomaticLayerPair pair);
    void suspendAutomaticLayerSwitch(tlvdemux::MseAutomaticLayerPair pair);
    void clearAutomaticLayerSwitch();
    void setTimestampOffset(std::int64_t timestamp_offset_us);
    void setPlaybackPosition(std::int64_t presentation_time_us);
    void setSdrInHlg(std::uint64_t video_track_id, bool enabled);
    void setHlgSdrPrototype(std::uint64_t video_track_id, bool enabled);
    void setVideoSignalling(std::uint64_t video_track_id,
                            tlvdemux::MseVideoSignalling signalling);
    void setOutputEnabled(bool enabled);
    std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted> push(
        const aribtlv::AccessUnit& unit);
    std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted> observeDamage(
        const aribtlv::DamageSpan& damage);
    void flush();
    std::optional<tlvdemux::MseLayerSwitchCancelled> endOfStream();
    std::optional<tlvdemux::MseLayerSwitchCancelled> reset();
    std::optional<tlvdemux::MseLayerSwitchCancelled> reposition();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
