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
        emit("onMseAudioSplice", event);
    }

    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        if (!has("onMseVideoSplice")) return;
        auto event = val::object();
        event.set("presentationTimeUs", splice.presentation_time_us);
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

void WasmMseRemuxer::configureAutomaticLayerSwitch(
    const tlvdemux::MseAutomaticLayerPair pair) {
    impl_->remuxer().configureAutomaticLayerSwitch(pair);
}

void WasmMseRemuxer::clearAutomaticLayerSwitch() {
    impl_->remuxer().clearAutomaticLayerSwitch();
}

void WasmMseRemuxer::setOutputEnabled(const bool enabled) {
    impl_->remuxer().setOutputEnabled(enabled);
}

std::optional<tlvdemux::MseAutomaticLayerSwitchRequest>
WasmMseRemuxer::push(const aribtlv::AccessUnit& unit) {
    return impl_->remuxer().push(unit);
}
void WasmMseRemuxer::observeDamage(const aribtlv::DamageSpan& damage) {
    impl_->remuxer().observeDamage(damage);
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
