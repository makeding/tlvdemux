#include "mse_remuxer.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>

namespace {

using emscripten::val;

val copy_bytes(const std::vector<std::uint8_t>& bytes) {
    auto output = val::global("Uint8Array").new_(bytes.size());
    if (!bytes.empty()) {
        output.call<void>(
            "set", emscripten::typed_memory_view(bytes.size(), bytes.data()));
    }
    return output;
}

val video_color_value(const std::optional<tlvdemux::MseVideoColor>& color) {
    if (!color) return val::null();
    auto result = val::object();
    result.set("primaries", color->primaries);
    result.set("transfer", color->transfer);
    result.set("matrix", color->matrix);
    result.set("fullRange", color->full_range);
    return result;
}

val hdr_static_metadata_value(
    const std::optional<tlvdemux::MseHdrStaticMetadata>& metadata) {
    if (!metadata) return val::null();
    auto result = val::object();
    auto primaries_x = val::array();
    auto primaries_y = val::array();
    for (std::size_t index = 0; index < 3; ++index) {
        primaries_x.set(index, metadata->display_primaries_x[index]);
        primaries_y.set(index, metadata->display_primaries_y[index]);
    }
    result.set("displayPrimariesX", primaries_x);
    result.set("displayPrimariesY", primaries_y);
    result.set("whitePointX", metadata->white_point_x);
    result.set("whitePointY", metadata->white_point_y);
    result.set("maxDisplayMasteringLuminance",
               metadata->max_display_mastering_luminance);
    result.set("minDisplayMasteringLuminance",
               metadata->min_display_mastering_luminance);
    result.set("maxContentLightLevel", metadata->max_content_light_level);
    result.set("maxPicAverageLightLevel", metadata->max_pic_average_light_level);
    result.set("hasMasteringDisplay", metadata->has_mastering_display);
    result.set("hasContentLight", metadata->has_content_light);
    return result;
}

const char* cancel_reason_name(
    const tlvdemux::MseLayerSwitchCancelReason reason) noexcept {
    switch (reason) {
    case tlvdemux::MseLayerSwitchCancelReason::EndOfInput: return "end-of-input";
    case tlvdemux::MseLayerSwitchCancelReason::Reset: return "reset";
    case tlvdemux::MseLayerSwitchCancelReason::Reposition: return "reposition";
    case tlvdemux::MseLayerSwitchCancelReason::SelectionChanged:
        return "selection-changed";
    }
    return "end-of-input";
}

const char* switch_reason_name(
    const tlvdemux::MseLayerSwitchReason reason) noexcept {
    switch (reason) {
    case tlvdemux::MseLayerSwitchReason::Manual: return "manual";
    case tlvdemux::MseLayerSwitchReason::HealthDegradation:
        return "health-degradation";
    case tlvdemux::MseLayerSwitchReason::SourceDamage: return "source-damage";
    }
    return "manual";
}

const char* damage_severity_name(
    const tlvdemux::PlaybackDamageSeverity severity) noexcept {
    switch (severity) {
    case tlvdemux::PlaybackDamageSeverity::Warning: return "warning";
    case tlvdemux::PlaybackDamageSeverity::Severe: return "severe";
    }
    return "warning";
}

const char* recovery_action_name(
    const tlvdemux::PlaybackRecoveryAction action) noexcept {
    switch (action) {
    case tlvdemux::PlaybackRecoveryAction::None: return "none";
    case tlvdemux::PlaybackRecoveryAction::SeekIfStalled: return "seek-if-stalled";
    case tlvdemux::PlaybackRecoveryAction::Seek: return "seek";
    case tlvdemux::PlaybackRecoveryAction::WaitForRecovery: return "wait-for-recovery";
    }
    return "none";
}

} // namespace

class WasmMseRemuxer::Impl final : public tlvdemux::MseSink {
public:
    explicit Impl(val callbacks, const std::uint32_t max_audio_channels,
                  WasmMseRemuxer::LayerSwitchCancellationHandler cancellation_handler)
        : callbacks_(std::move(callbacks)),
          remuxer_(*this, tlvdemux::MseOptions{max_audio_channels}),
          cancellation_handler_(std::move(cancellation_handler)) {}

    void onMseInit(tlvdemux::MseTrackInit&& init) override {
        if (!has("onMseInit")) return;
        auto event = val::object();
        event.set("type", init.type);
        event.set("mime", init.mime);
        event.set("data", copy_bytes(init.data));
        event.set("width", init.width);
        event.set("height", init.height);
        event.set("sampleRate", init.sample_rate);
        event.set("channels", init.channels);
        emit("onMseInit", event);
    }

    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        if (!has("onMseSegment")) return;
        auto event = val::object();
        event.set("type", segment.type);
        event.set("data", copy_bytes(segment.data));
        event.set("startTimeUs", segment.start_time_us);
        event.set("endTimeUs", segment.end_time_us);
        emit("onMseSegment", event);
    }

    void onMseAudioSplice(const tlvdemux::MseAudioSplice& splice) override {
        if (!has("onMseAudioSplice")) return;
        auto event = val::object();
        event.set("presentationTimeUs", splice.presentation_time_us);
        event.set("timestampOffsetUs", splice.timestamp_offset_us);
        emit("onMseAudioSplice", event);
    }

    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        if (!has("onMseVideoSplice")) return;
        auto event = val::object();
        event.set("presentationTimeUs", splice.presentation_time_us);
        event.set("timestampOffsetUs", splice.timestamp_offset_us);
        emit("onMseVideoSplice", event);
    }

    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        if (!has("onMseLayerSwitch")) return;
        auto event = val::object();
        event.set("videoTrackId", layer.video_track_id);
        event.set("audioTrackId", layer.audio_track_id);
        event.set("videoPresentationTimeUs", layer.video_presentation_time_us);
        event.set("audioPresentationTimeUs", layer.audio_presentation_time_us);
        emit("onMseLayerSwitch", event);
    }

    void onMseLayerSwitchStarted(
        const tlvdemux::MseLayerSwitchStarted& started) override {
        if (!has("onMseLayerSwitchStarted")) return;
        auto event = val::object();
        event.set("videoTrackId", started.video_track_id);
        event.set("audioTrackId", started.audio_track_id);
        event.set("previousVideoTrackId", started.previous_video_track_id);
        event.set("previousAudioTrackId", started.previous_audio_track_id);
        event.set("earliestPresentationTimeUs",
                  started.earliest_presentation_time_us);
        event.set("reason", std::string(switch_reason_name(started.reason)));
        emit("onMseLayerSwitchStarted", event);
    }

    void onMseLayerSwitchCancelled(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) override {
        if (cancellation_handler_) cancellation_handler_(cancelled);
        if (!has("onMseLayerSwitchCancelled")) return;
        auto event = val::object();
        event.set("videoTrackId", cancelled.video_track_id);
        event.set("audioTrackId", cancelled.audio_track_id);
        event.set("previousVideoTrackId", cancelled.previous_video_track_id);
        event.set("previousAudioTrackId", cancelled.previous_audio_track_id);
        event.set("reason", std::string(cancel_reason_name(cancelled.reason)));
        emit("onMseLayerSwitchCancelled", event);
    }

    void onMseVideoStart(const tlvdemux::MseVideoStart& start) override {
        if (!has("onMseVideoStart")) return;
        auto event = val::object();
        event.set("nalType", start.nal_type);
        event.set("signalledRandomAccess", start.signalled_random_access);
        emit("onMseVideoStart", event);
    }

    void onMseVideoRecovery(
        const tlvdemux::MseVideoRecoveryEvent& recovery) override {
        if (!has("onMseVideoRecovery")) return;
        auto event = val::object();
        event.set("videoTrackId", recovery.video_track_id);
        event.set("presentationTimeUs", recovery.presentation_time_us);
        const char* phase = "observation-started";
        if (recovery.phase == tlvdemux::MseVideoRecoveryPhase::CandidateRejected) {
            phase = "candidate-rejected";
        } else if (recovery.phase ==
                   tlvdemux::MseVideoRecoveryPhase::StableRapCommitted) {
            phase = "stable-rap-committed";
        }
        event.set("phase", std::string(phase));
        event.set("continuityState", recovery.continuity_state);
        event.set("damageStartUs", recovery.damage_start_us
            ? val(*recovery.damage_start_us) : val::null());
        event.set("aacFrontierUs", recovery.aac_frontier_us
            ? val(*recovery.aac_frontier_us) : val::null());
        event.set("frozenThroughUs", recovery.frozen_through_us
            ? val(*recovery.frozen_through_us) : val::null());
        event.set("candidateRapUs", recovery.candidate_rap_us
            ? val(*recovery.candidate_rap_us) : val::null());
        event.set("fallbackTrackId", recovery.fallback_track_id
            ? val(*recovery.fallback_track_id) : val::null());
        event.set("lastVideoOutputEndUs", recovery.last_video_output_end_us
            ? val(*recovery.last_video_output_end_us) : val::null());
        emit("onMseVideoRecovery", event);
    }

    void onMseVideoProperties(
        const tlvdemux::MseVideoProperties& properties) override {
        if (!has("onMseVideoProperties")) return;
        auto event = val::object();
        event.set("trackId", properties.track_id);
        event.set("presentationTimeUs", properties.presentation_time_us);
        event.set("width", properties.width);
        event.set("height", properties.height);
        event.set("codec", properties.codec);
        event.set("sourceColor", video_color_value(properties.source_color));
        event.set("outputColor", video_color_value(properties.output_color));
        event.set("hdrStaticMetadata",
                  hdr_static_metadata_value(properties.hdr_static_metadata));
        if (properties.source_signalling) {
            auto signalling = val::object();
            signalling.set("hdrWcgIdc", properties.source_signalling->hdr_wcg_idc
                ? val(*properties.source_signalling->hdr_wcg_idc) : val::null());
            signalling.set("videoTransferCharacteristics",
                properties.source_signalling->video_transfer_characteristics
                    ? val(*properties.source_signalling->video_transfer_characteristics)
                    : val::null());
            event.set("sourceSignalling", signalling);
        } else {
            event.set("sourceSignalling", val::null());
        }
        event.set("sourceSignallingMismatch", properties.source_signalling_mismatch);
        event.set("sdrInHlg", properties.sdr_in_hlg);
        event.set("hlgSdrPrototype", properties.hlg_sdr_prototype);
        emit("onMseVideoProperties", event);
    }

    void onPlaybackDamage(const tlvdemux::PlaybackDamage& damage) override {
        if (!has("onPlaybackDamage")) return;
        auto event = val::object();
        event.set("code", std::string("TLV_SOURCE_DAMAGE"));
        event.set("videoTrackId", damage.video_track_id);
        event.set("startTimeUs", damage.start_time_us.has_value()
            ? val(*damage.start_time_us) : val::null());
        event.set("endTimeUs", damage.end_time_us);
        event.set("recoveryTimeUs", damage.recovery_time_us.has_value()
            ? val(*damage.recovery_time_us) : val::null());
        event.set("startInputOffset", damage.start_input_offset);
        event.set("endInputOffset", damage.end_input_offset);
        event.set("recoveryInputOffset", damage.recovery_input_offset);
        event.set("recoveryRestartOffset", damage.recovery_restart_offset);
        event.set("severity", std::string(damage_severity_name(damage.severity)));
        event.set("action", std::string(recovery_action_name(damage.action)));
        emit("onPlaybackDamage", event);
    }

    tlvdemux::MseRemuxer& remuxer() noexcept { return remuxer_; }

private:
    bool has(const char* name) const {
        return callbacks_[name].typeOf().as<std::string>() == "function";
    }

    void emit(const char* name, const val& event) {
        callbacks_[name].call<void>("call", callbacks_, event);
    }

    val callbacks_;
    tlvdemux::MseRemuxer remuxer_;
    WasmMseRemuxer::LayerSwitchCancellationHandler cancellation_handler_;
};

WasmMseRemuxer::WasmMseRemuxer(val callbacks,
                               const std::uint32_t max_audio_channels,
                               LayerSwitchCancellationHandler cancellation_handler)
    : impl_(std::make_unique<Impl>(std::move(callbacks), max_audio_channels,
                                  std::move(cancellation_handler))) {}
WasmMseRemuxer::~WasmMseRemuxer() = default;

std::optional<tlvdemux::MseLayerSwitchCancelled> WasmMseRemuxer::selectTrack(
    const aribtlv::TrackKind kind, std::optional<std::uint64_t> id) {
    return impl_->remuxer().selectTrack(kind, id);
}

std::optional<std::int64_t> WasmMseRemuxer::switchAudioTrack(
    const std::uint64_t id, const std::int64_t earliest_presentation_time_us) {
    return impl_->remuxer().switchAudioTrack(id, earliest_presentation_time_us);
}

bool WasmMseRemuxer::switchLayer(
    const std::uint64_t video_track_id, const std::uint64_t audio_track_id,
    const std::int64_t earliest_presentation_time_us) {
    return impl_->remuxer().switchLayer(
        video_track_id, audio_track_id, earliest_presentation_time_us);
}

bool WasmMseRemuxer::switchLayerAtPlaybackEntry(
    const std::uint64_t video_track_id, const std::uint64_t audio_track_id,
    const std::int64_t playback_entry_time_us) {
    return impl_->remuxer().switchLayerAtPlaybackEntry(
        video_track_id, audio_track_id, playback_entry_time_us);
}

void WasmMseRemuxer::configureAutomaticLayerSwitch(
    const tlvdemux::MseAutomaticLayerPair pair) {
    impl_->remuxer().configureAutomaticLayerSwitch(pair);
}

void WasmMseRemuxer::suspendAutomaticLayerSwitch(
    const tlvdemux::MseAutomaticLayerPair pair) {
    impl_->remuxer().suspendAutomaticLayerSwitch(pair);
}

void WasmMseRemuxer::clearAutomaticLayerSwitch() {
    impl_->remuxer().clearAutomaticLayerSwitch();
}

void WasmMseRemuxer::setTimestampOffset(const std::int64_t timestamp_offset_us) {
    impl_->remuxer().setTimestampOffset(timestamp_offset_us);
}

bool WasmMseRemuxer::repeatLastClosedVideoWindow(
    const std::int64_t start_time_us, const std::int64_t end_time_us) {
    return impl_->remuxer().repeatLastClosedVideoWindow(start_time_us, end_time_us);
}

void WasmMseRemuxer::clearLastClosedVideoPicture() {
    impl_->remuxer().clearLastClosedVideoPicture();
}

void WasmMseRemuxer::setRecordedSeekConcealmentTarget(
    const std::optional<std::int64_t> presentation_time_us) {
    impl_->remuxer().setRecordedSeekConcealmentTarget(presentation_time_us);
}

void WasmMseRemuxer::beginMseRecordedSeek() {
    impl_->remuxer().beginMseRecordedSeek();
}

void WasmMseRemuxer::finishMseRecordedSeek(
    const std::int64_t playback_position_us) {
    impl_->remuxer().finishMseRecordedSeek(playback_position_us);
}

void WasmMseRemuxer::cancelMseRecordedSeek() {
    impl_->remuxer().cancelMseRecordedSeek();
}

void WasmMseRemuxer::setPlaybackPosition(
    const std::int64_t presentation_time_us) {
    impl_->remuxer().setPlaybackPosition(presentation_time_us);
}

void WasmMseRemuxer::setSdrInHlg(
    const std::uint64_t video_track_id, const bool enabled) {
    impl_->remuxer().setSdrInHlg(video_track_id, enabled);
}

void WasmMseRemuxer::setHlgSdrPrototype(
    const std::uint64_t video_track_id, const bool enabled) {
    impl_->remuxer().setHlgSdrPrototype(video_track_id, enabled);
}

void WasmMseRemuxer::setVideoSignalling(
    const std::uint64_t video_track_id,
    const tlvdemux::MseVideoSignalling signalling) {
    impl_->remuxer().setVideoSignalling(video_track_id, signalling);
}

void WasmMseRemuxer::setOutputEnabled(const bool enabled) {
    impl_->remuxer().setOutputEnabled(enabled);
}

std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted>
WasmMseRemuxer::push(const aribtlv::AccessUnit& unit) {
    return impl_->remuxer().push(unit);
}
std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted>
WasmMseRemuxer::observeDamage(const aribtlv::DamageSpan& damage) {
    return impl_->remuxer().observeDamage(damage);
}
void WasmMseRemuxer::flush() { impl_->remuxer().flush(); }
std::optional<tlvdemux::MseLayerSwitchCancelled> WasmMseRemuxer::endOfStream() {
    return impl_->remuxer().endOfStream();
}
std::optional<tlvdemux::MseLayerSwitchCancelled> WasmMseRemuxer::reset() {
    return impl_->remuxer().reset();
}
std::optional<tlvdemux::MseLayerSwitchCancelled> WasmMseRemuxer::reposition() {
    return impl_->remuxer().reposition();
}
