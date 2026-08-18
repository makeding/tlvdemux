#include <tlvdemux/mse_remuxer.hpp>

#include "mse/video_access_unit_history.hpp"
#include "mse/video_layer_state_machine.hpp"
#include "mse_track_muxers.hpp"
#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>

namespace {

using tlvdemux::detail::mse::VideoAccessUnitHistory;
using tlvdemux::detail::mse::VideoLayerPair;
using tlvdemux::detail::mse::VideoLayerStateMachine;
using tlvdemux::detail::mse::remux::AacMuxer;
using tlvdemux::detail::mse::remux::HevcMuxer;
using tlvdemux::detail::mse::remux::Output;
using tlvdemux::detail::mse::remux::kLayerSwitchAudioBufferUs;
using tlvdemux::detail::mse::remux::kLayerSwitchMaxAvGapUs;
using tlvdemux::detail::mse::remux::kLayerSwitchVideoBufferUs;
using tlvdemux::detail::mse::scaled;

} // namespace

class tlvdemux::MseRemuxer::Impl {
public:
    explicit Impl(MseSink& sink, const MseOptions options)
        : sink(sink), output(sink, options.output_mode), video(output), options(options) {}

    std::optional<MseLayerSwitchCancelled> select(
        const aribtlv::TrackKind kind, std::optional<std::uint64_t> id) {
        std::optional<MseLayerSwitchCancelled> cancelled;
        if (kind == aribtlv::TrackKind::Video || kind == aribtlv::TrackKind::Audio) {
            cancelled = cancel_layer(MseLayerSwitchCancelReason::SelectionChanged);
        }
        if (kind == aribtlv::TrackKind::Video) {
            video.cancel_staged_switch();
            output.discard_staged_video();
            video_history.clear();
            video_id = id;
            damage_advisor.selectVideoTrack(id);
            automatic_layers.select(id);
            return cancelled;
        }
        if (kind != aribtlv::TrackKind::Audio) return cancelled;
        video.cancel_staged_switch();
        output.discard_staged_video();
        if (audio_id == id && active_audio != nullptr) return cancelled;
        std::optional<std::int64_t> resume_at;
        std::uint32_t resume_timescale = 0;
        if (active_audio) {
            // Seal and emit every old-track sample before a new init segment
            // can be emitted. The returned end is therefore a real buffered
            // boundary, not a guess based on an unflushed pending sample.
            active_audio->flush();
            resume_at = active_audio->timeline_end();
            resume_timescale = active_audio->track_timescale().value_or(0);
        }
        audio_id = id;
        if (!id) {
            active_audio = nullptr;
            return cancelled;
        }
        auto [iterator, inserted] =
            audio.try_emplace(*id, output, options.max_audio_channels);
        active_audio = &iterator->second;
        if (!inserted) active_audio->activate();
        if (resume_at.has_value() && resume_timescale != 0) {
            active_audio->resume_at(*resume_at, resume_timescale);
        }
        return cancelled;
    }

    std::optional<std::int64_t> switch_audio(
        const std::uint64_t id, const std::int64_t earliest_presentation_time_us,
        const std::optional<std::int64_t> output_boundary_us = std::nullopt) {
        if (pending_layer) return std::nullopt;
        if (audio_id == id && active_audio != nullptr) return std::nullopt;
        const auto candidate = audio.find(id);
        if (candidate == audio.end()) return std::nullopt;
        const auto boundary = candidate->second.activate_from(
            earliest_presentation_time_us, output_boundary_us);
        if (!boundary.has_value()) return std::nullopt;
        if (active_audio) active_audio->discard();
        audio_id = id;
        active_audio = &candidate->second;
        return boundary;
    }

    bool switch_layer(const std::uint64_t target_video_id,
                      const std::uint64_t target_audio_id,
                      const std::int64_t earliest_presentation_time_us) {
        if (target_video_id == 0 || target_audio_id == 0 ||
            video_id == target_video_id || pending_layer) return false;
        pending_layer = PendingLayerSwitch{
            target_video_id, target_audio_id,
            video_id.value_or(0), audio_id.value_or(0),
            earliest_presentation_time_us, std::nullopt};
        video.stage_next_switch();
        automatic_layers.switchStarted(target_video_id);
        video_id = target_video_id;
        for (const auto& unit : video_history.take_from(
                 target_video_id, earliest_presentation_time_us)) {
            push_selected_video(unit);
        }
        return true;
    }

    void complete_layer_switch() {
        if (!pending_layer || !pending_layer->video_boundary_us) return;
        auto staged_video = output.staged_video_range();
        if (!staged_video ||
            staged_video->second - staged_video->first < kLayerSwitchVideoBufferUs) return;
        video.flush();
        staged_video = output.staged_video_range();
        const auto video_boundary = std::min(
            *pending_layer->video_boundary_us, staged_video->first);
        output.set_staged_video_splice(video_boundary);
        if (audio_id == pending_layer->audio_track_id && active_audio != nullptr) {
            const auto completed_video_id = pending_layer->video_track_id;
            output.commit_staged_video();
            output.layer_switch(
                pending_layer->video_track_id, pending_layer->audio_track_id,
                video_boundary, video_boundary);
            pending_layer.reset();
            automatic_layers.switchCompleted(completed_video_id);
            damage_advisor.selectVideoTrack(completed_video_id);
            return;
        }
        const auto candidate = audio.find(pending_layer->audio_track_id);
        const auto earliest_audio = std::max(
            pending_layer->earliest_presentation_time_us,
            video_boundary);
        if (candidate == audio.end()) return;
        const auto audio_boundary = candidate->second.contiguous_activation_boundary_from(
            earliest_audio, kLayerSwitchAudioBufferUs);
        if (!audio_boundary) return;
        if (*audio_boundary - video_boundary > kLayerSwitchMaxAvGapUs) {
            pending_layer->earliest_presentation_time_us = *audio_boundary;
            pending_layer->video_boundary_us.reset();
            output.discard_staged_video();
            video.retry_staged_switch();
            return;
        }
        std::optional<std::int64_t> output_audio_boundary;
        if (active_audio != nullptr) {
            active_audio->flush();
            const auto active_end = active_audio->timeline_end();
            const auto active_timescale = active_audio->track_timescale();
            if (active_end.has_value() && active_timescale.has_value()) {
                const auto active_end_us = scaled(
                    *active_end, *active_timescale, 1000000);
                if (active_end_us > *audio_boundary) {
                    output_audio_boundary = active_end_us;
                }
            }
        }
        const auto completed = *pending_layer;
        pending_layer.reset();
        output.commit_staged_video();
        const auto boundary = switch_audio(
            completed.audio_track_id, earliest_audio, output_audio_boundary);
        if (!boundary) return;
        output.layer_switch(
            completed.video_track_id, completed.audio_track_id,
            video_boundary, *boundary);
        automatic_layers.switchCompleted(completed.video_track_id);
        damage_advisor.selectVideoTrack(completed.video_track_id);
    }

    std::optional<tlvdemux::MseAutomaticLayerSwitchRequest> push(
        const aribtlv::AccessUnit& unit) {
        if ((unit.codec == aribtlv::Codec::Hevc ||
             unit.codec == aribtlv::Codec::AacLatm) &&
            (unit.pts.timescale <= 1 || unit.dts.timescale <= 1)) return std::nullopt;
        const auto automatic = automatic_layers.observe(unit);
        if (unit.codec == aribtlv::Codec::Hevc) {
            if (video_id && unit.track_id == *video_id) {
                push_selected_video(unit);
            } else {
                video_history.push(unit);
            }
            if (!automatic) return std::nullopt;
            return tlvdemux::MseAutomaticLayerSwitchRequest{
                automatic->video_track_id,
                automatic->audio_track_id,
                automatic->earliest_presentation_time_us,
            };
        }
        if (unit.codec == aribtlv::Codec::AacLatm) {
            auto [iterator, inserted] = audio.try_emplace(
                unit.track_id, output, options.max_audio_channels);
            if (inserted && audio_id && unit.track_id == *audio_id) {
                active_audio = &iterator->second;
            }
            const bool active = audio_id && unit.track_id == *audio_id &&
                active_audio == &iterator->second;
            iterator->second.push(unit, active,
                                  active && enabled && video.started(),
                                  video.timeline_offset_us());
            if (pending_layer && unit.track_id == pending_layer->audio_track_id) {
                complete_layer_switch();
            }
        }
        return std::nullopt;
    }

    void observe_damage(const aribtlv::DamageSpan& damage) {
        const auto playback_damage = damage_advisor.observe(damage);
        if (playback_damage) sink.onPlaybackDamage(*playback_damage);
    }

    void flush() {
        video.flush();
        if (active_audio) active_audio->flush();
    }

    std::optional<MseLayerSwitchCancelled> end_of_stream() {
        flush();
        return cancel_layer(MseLayerSwitchCancelReason::EndOfInput);
    }

    std::optional<MseLayerSwitchCancelled> reset() {
        auto cancelled = cancel_layer(MseLayerSwitchCancelReason::Reset);
        video.reset(true);
        video_history.clear();
        audio.clear();
        active_audio = nullptr;
        output.discard_staged_video();
        automatic_layers.resetObservations();
        return cancelled;
    }

    std::optional<MseLayerSwitchCancelled> reposition() {
        auto cancelled = cancel_layer(MseLayerSwitchCancelReason::Reposition);
        video.reset();
        video_history.clear();
        for (auto& entry : audio) entry.second.discontinuity();
        output.discard_staged_video();
        automatic_layers.resetObservations();
        return cancelled;
    }

    struct PendingLayerSwitch {
        std::uint64_t video_track_id = 0;
        std::uint64_t audio_track_id = 0;
        std::uint64_t previous_video_track_id = 0;
        std::uint64_t previous_audio_track_id = 0;
        std::int64_t earliest_presentation_time_us = 0;
        std::optional<std::int64_t> video_boundary_us;
    };

    void push_selected_video(const aribtlv::AccessUnit& unit) {
        if (unit.discontinuity && !video.is_input_track_switch(unit) &&
            !(pending_layer && unit.track_id == pending_layer->video_track_id)) {
            // A damaged selected video layer does not invalidate audio already
            // prepared for another asset layer. Reset only the audio currently
            // being emitted; otherwise the fallback history disappears at the
            // exact moment it is needed.
            if (active_audio) active_audio->discontinuity();
        }
        video.push(unit, enabled);
        if (pending_layer && unit.track_id == pending_layer->video_track_id) {
            const auto boundary = video.take_splice_boundary_us();
            if (boundary) pending_layer->video_boundary_us = boundary;
            complete_layer_switch();
        }
    }

    std::optional<MseLayerSwitchCancelled> cancel_layer(
        const MseLayerSwitchCancelReason reason) {
        if (!pending_layer) return std::nullopt;
        const auto pending = *pending_layer;
        pending_layer.reset();
        video.cancel_staged_switch();
        output.discard_staged_video();
        video_id = pending.previous_video_track_id == 0
            ? std::nullopt
            : std::optional<std::uint64_t>{pending.previous_video_track_id};
        const MseLayerSwitchCancelled cancelled{
            pending.video_track_id,
            pending.audio_track_id,
            pending.previous_video_track_id,
            pending.previous_audio_track_id,
            reason,
        };
        automatic_layers.switchCancelled(cancelled.previous_video_track_id);
        sink.onMseLayerSwitchCancelled(cancelled);
        return cancelled;
    }

    MseSink& sink;
    Output output;
    HevcMuxer video;
    VideoAccessUnitHistory video_history;
    VideoLayerStateMachine automatic_layers;
    PlaybackDamageAdvisor damage_advisor;
    std::map<std::uint64_t, AacMuxer> audio;
    AacMuxer* active_audio = nullptr;
    MseOptions options;
    std::optional<std::uint64_t> video_id;
    std::optional<std::uint64_t> audio_id;
    std::optional<PendingLayerSwitch> pending_layer;
    bool enabled = true;
};

tlvdemux::MseRemuxer::MseRemuxer(MseSink& sink, const MseOptions options)
    : impl_(std::make_unique<Impl>(sink, options)) {}
tlvdemux::MseRemuxer::~MseRemuxer() = default;

std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::selectTrack(const TrackKind kind,
                                  std::optional<std::uint64_t> id) {
    return impl_->select(kind, id);
}

std::optional<std::int64_t> tlvdemux::MseRemuxer::switchAudioTrack(
    const std::uint64_t id, const std::int64_t earliest_presentation_time_us) {
    return impl_->switch_audio(id, earliest_presentation_time_us);
}

bool tlvdemux::MseRemuxer::switchLayer(
    const std::uint64_t video_track_id, const std::uint64_t audio_track_id,
    const std::int64_t earliest_presentation_time_us) {
    return impl_->switch_layer(
        video_track_id, audio_track_id, earliest_presentation_time_us);
}

void tlvdemux::MseRemuxer::configureAutomaticLayerSwitch(
    const MseAutomaticLayerPair pair) {
    impl_->automatic_layers.configure(VideoLayerPair{
        pair.preferred_video_track_id,
        pair.preferred_audio_track_id,
        pair.fallback_video_track_id,
        pair.fallback_audio_track_id,
    });
}

void tlvdemux::MseRemuxer::clearAutomaticLayerSwitch() {
    impl_->automatic_layers.clearConfiguration();
}

void tlvdemux::MseRemuxer::setSdrInHlg(
    const std::uint64_t video_track_id, const bool enabled) {
    impl_->video.set_sdr_in_hlg(video_track_id, enabled);
}

void tlvdemux::MseRemuxer::setHlgSdrPrototype(
    const std::uint64_t video_track_id, const bool enabled) {
    impl_->video.set_hlg_sdr_prototype(video_track_id, enabled);
}

void tlvdemux::MseRemuxer::setVideoSignalling(
    const std::uint64_t video_track_id,
    const MseVideoSignalling signalling) {
    impl_->video.set_video_signalling(video_track_id, signalling);
}

void tlvdemux::MseRemuxer::setOutputEnabled(const bool enabled) {
    const bool was_enabled = impl_->enabled;
    impl_->enabled = enabled;
    impl_->output.set_enabled(enabled);
    if (enabled && !was_enabled && impl_->active_audio) {
        impl_->active_audio->activate();
    }
}

std::optional<tlvdemux::MseAutomaticLayerSwitchRequest>
tlvdemux::MseRemuxer::push(const AccessUnit& unit) { return impl_->push(unit); }
void tlvdemux::MseRemuxer::observeDamage(const aribtlv::DamageSpan& damage) {
    impl_->observe_damage(damage);
}
void tlvdemux::MseRemuxer::flush() { impl_->flush(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::endOfStream() { return impl_->end_of_stream(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reset() { return impl_->reset(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reposition() { return impl_->reposition(); }
