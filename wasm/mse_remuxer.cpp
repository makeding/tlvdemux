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
using tlvdemux::detail::mse::VideoLayerObservation;
using tlvdemux::detail::mse::VideoLayerSwitchReason;
using tlvdemux::detail::mse::VideoLayerStateMachine;
using tlvdemux::detail::mse::VideoLayerSwitchRequest;
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
        // Track catalogues are replayed after reposition and worker-backed
        // integrations can acknowledge the worker's automatic selection with
        // the same public selectTrack() call. That acknowledgement is not a
        // new selection: resetting the active muxer here can discard the
        // recorded-seek landing that is currently forming exact A/V coverage.
        if (!pending_layer && id.has_value() && kind == aribtlv::TrackKind::Video &&
            video_id == id) {
            return std::nullopt;
        }
        if (!pending_layer && id.has_value() && kind == aribtlv::TrackKind::Audio &&
            audio_id == id && active_audio != nullptr) {
            return std::nullopt;
        }
        if (kind == aribtlv::TrackKind::Video || kind == aribtlv::TrackKind::Audio) {
            automatic_layers.clearUnrecoveredDamage();
        }
        std::optional<MseLayerSwitchCancelled> cancelled;
        if (kind == aribtlv::TrackKind::Video || kind == aribtlv::TrackKind::Audio) {
            cancelled = cancel_layer(MseLayerSwitchCancelReason::SelectionChanged);
        }
        if (kind == aribtlv::TrackKind::Video) {
            video.cancel_staged_switch();
            video.mark_output_not_started();
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
            resume_at = active_audio->emitted_timeline_end();
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
        active_audio->set_source_buffer_timestamp_offset(mse_timestamp_offset_us);
        if (resume_at.has_value() && resume_timescale != 0) {
            active_audio->resume_at(*resume_at, resume_timescale);
        }
        return cancelled;
    }

    std::optional<std::int64_t> switch_audio(
        const std::uint64_t id, const std::int64_t earliest_presentation_time_us,
        const std::optional<std::int64_t> output_boundary_us = std::nullopt,
        const std::optional<std::int64_t> timestamp_offset_us = std::nullopt) {
        if (pending_layer) return std::nullopt;
        if (audio_id == id && active_audio != nullptr) return std::nullopt;
        const auto candidate = audio.find(id);
        if (candidate == audio.end()) return std::nullopt;
        const auto boundary = candidate->second.activate_from(
            earliest_presentation_time_us, output_boundary_us,
            timestamp_offset_us.value_or(mse_timestamp_offset_us));
        if (!boundary.has_value()) return std::nullopt;
        if (active_audio) active_audio->discard();
        audio_id = id;
        active_audio = &candidate->second;
        return boundary;
    }

    bool switch_layer(const std::uint64_t target_video_id,
                      const std::uint64_t target_audio_id,
                      const std::int64_t earliest_presentation_time_us,
                      const MseLayerSwitchReason reason,
                      const bool user_initiated = false,
                      const bool map_to_playback_entry = false) {
        if (target_video_id == 0 || target_audio_id == 0 ||
            video_id == target_video_id || pending_layer) return false;
        if (user_initiated) automatic_layers.clearUnrecoveredDamage();
        pending_layer = PendingLayerSwitch{
            target_video_id, target_audio_id,
            video_id.value_or(0), audio_id.value_or(0),
            earliest_presentation_time_us, std::nullopt, reason,
            map_to_playback_entry ||
                (reason == MseLayerSwitchReason::HealthDegradation &&
                 !video.output_started())};
        video.stage_next_switch();
        video_id = target_video_id;
        sink.onMseLayerSwitchStarted(MseLayerSwitchStarted{
            target_video_id,
            target_audio_id,
            pending_layer->previous_video_track_id,
            pending_layer->previous_audio_track_id,
            earliest_presentation_time_us,
            reason,
        });
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
        // The staged range already contains enough complete media. Do not
        // flush the pending video sample here: its duration is only known when
        // the next DTS arrives, and reusing the previous duration can overlap
        // that next fragment by one broadcast-timescale tick.
        const auto video_boundary = std::min(
            *pending_layer->video_boundary_us, staged_video->first);
        const auto timestamp_offset_us = pending_layer->map_to_playback_entry
            ? pending_layer->earliest_presentation_time_us - video_boundary
            : mse_timestamp_offset_us;
        output.set_staged_video_splice(video_boundary, timestamp_offset_us);
        if (audio_id == pending_layer->audio_track_id && active_audio != nullptr) {
            const auto completed_video_id = pending_layer->video_track_id;
            output.commit_staged_video();
            output.layer_switch(
                pending_layer->video_track_id, pending_layer->audio_track_id,
                video_boundary, video_boundary);
            pending_layer.reset();
            mse_timestamp_offset_us = timestamp_offset_us;
            synchronize_audio_timestamp_offsets();
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
        const auto completed = *pending_layer;
        pending_layer.reset();
        output.commit_staged_video();
        const auto boundary = switch_audio(
            completed.audio_track_id, earliest_audio, video_boundary,
            std::optional<std::int64_t>{timestamp_offset_us});
        if (!boundary) return;
        mse_timestamp_offset_us = timestamp_offset_us;
        synchronize_audio_timestamp_offsets();
        output.layer_switch(
            completed.video_track_id, completed.audio_track_id,
            video_boundary, *boundary);
        automatic_layers.switchCompleted(completed.video_track_id);
        damage_advisor.selectVideoTrack(completed.video_track_id);
    }

    std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted> begin_automatic_switch(
        const std::optional<VideoLayerSwitchRequest>& request,
        const MseLayerSwitchReason reason) {
        if (recorded_seek_active || !request) return std::nullopt;
        if (!switch_layer(request->video_track_id, request->audio_track_id,
                          request->earliest_presentation_time_us, reason)) {
            return std::nullopt;
        }
        return tlvdemux::MseAutomaticLayerSwitchAccepted{
            request->video_track_id,
            request->audio_track_id,
            request->earliest_presentation_time_us,
        };
    }

    std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted> push(
        const aribtlv::AccessUnit& unit) {
        if ((unit.codec == aribtlv::Codec::Hevc ||
             unit.codec == aribtlv::Codec::AacLatm) &&
            (unit.pts.timescale <= 1 || unit.dts.timescale <= 1)) return std::nullopt;
        if (unit.codec == aribtlv::Codec::Hevc) {
            if (video_id && unit.track_id == *video_id) {
                push_selected_video(unit);
                automatic_layers.setSelectedOutputStarted(video.output_started());
            } else {
                video_history.push(unit);
            }
            const auto automatic = automatic_layers.observe(unit);
            if (!recorded_seek_active && !pending_layer && automatic.playback_damage) {
                sink.onPlaybackDamage(*automatic.playback_damage);
            }
            if (pending_layer) return std::nullopt;
            return begin_automatic_switch(
                automatic.switch_request,
                automatic.switch_reason == VideoLayerSwitchReason::SourceDamage
                    ? MseLayerSwitchReason::SourceDamage
                    : MseLayerSwitchReason::HealthDegradation);
        }
        if (unit.codec == aribtlv::Codec::AacLatm) {
            auto [iterator, inserted] = audio.try_emplace(
                unit.track_id, output, options.max_audio_channels);
            if (inserted) {
                iterator->second.set_source_buffer_timestamp_offset(
                    mse_timestamp_offset_us);
            }
            if (inserted && audio_id && unit.track_id == *audio_id) {
                active_audio = &iterator->second;
            }
            const bool active = audio_id && unit.track_id == *audio_id &&
                active_audio == &iterator->second;
            iterator->second.push(unit, active,
                                  active && enabled && video.audio_output_ready(),
                                  video.timeline_offset_us());
            const auto automatic = automatic_layers.observe(unit);
            if (!recorded_seek_active && !pending_layer && automatic.playback_damage) {
                sink.onPlaybackDamage(*automatic.playback_damage);
            }
            if (pending_layer && unit.track_id == pending_layer->audio_track_id) {
                complete_layer_switch();
            }
            if (pending_layer) return std::nullopt;
            return begin_automatic_switch(
                automatic.switch_request,
                automatic.switch_reason == VideoLayerSwitchReason::SourceDamage
                    ? MseLayerSwitchReason::SourceDamage
                    : MseLayerSwitchReason::HealthDegradation);
        }
        return std::nullopt;
    }

    std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted> observe_damage(
        const aribtlv::DamageSpan& damage) {
        video.observe_source_damage(damage);
        const auto playback_damage = damage_advisor.observe(damage);
        if (!playback_damage) return std::nullopt;
        const auto observation = automatic_layers.observeDamage(*playback_damage);
        if (recorded_seek_active) return std::nullopt;
        if (!observation.playback_damage && !observation.switch_request) {
            sink.onPlaybackDamage(*playback_damage);
            return std::nullopt;
        }
        if (!pending_layer && observation.playback_damage) {
            sink.onPlaybackDamage(*observation.playback_damage);
        }
        if (pending_layer) return std::nullopt;
        return begin_automatic_switch(
            observation.switch_request, MseLayerSwitchReason::SourceDamage);
    }

    void flush() {
        video.flush();
        if (active_audio) active_audio->flush();
    }

    std::optional<MseLayerSwitchCancelled> end_of_stream() {
        flush();
        // Flushing can turn the final pending video sample into the staged
        // interval and the final audio sample into the contiguous activation
        // window needed by complete_layer_switch(). Give that fully prepared
        // switch one last commit opportunity before treating EOF as failure.
        complete_layer_switch();
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
        mse_timestamp_offset_us = 0;
        return cancelled;
    }

    std::optional<MseLayerSwitchCancelled> reposition() {
        auto cancelled = cancel_layer(MseLayerSwitchCancelReason::Reposition);
        video.reset();
        video_history.clear();
        for (auto& entry : audio) entry.second.discontinuity();
        synchronize_audio_timestamp_offsets();
        output.discard_staged_video();
        automatic_layers.resetObservations();
        return cancelled;
    }

    void begin_recorded_seek() {
        if (recorded_seek_active) {
            automatic_layers.discardDeferredDecision();
        }
        cancel_layer(MseLayerSwitchCancelReason::Reposition);
        recorded_seek_active = true;
        automatic_layers.suspend();
    }

    void finish_recorded_seek(const std::int64_t playback_position_us) {
        if (!recorded_seek_active) return;
        automatic_layers.setPlaybackPosition(
            playback_position_us - mse_timestamp_offset_us);
        recorded_seek_active = false;
        if (automatic_requested) automatic_layers.resume();
        const auto automatic = automatic_layers.reevaluate();
        begin_automatic_switch(
            automatic.switch_request,
            automatic.switch_reason == VideoLayerSwitchReason::SourceDamage
                ? MseLayerSwitchReason::SourceDamage
                : MseLayerSwitchReason::HealthDegradation);
    }

    void cancel_recorded_seek() {
        if (!recorded_seek_active) return;
        recorded_seek_active = false;
        // Observations may keep both layer trackers warm during the fence, but
        // cancelling the transaction must not let its deferred damage vote
        // become a switch on the first access unit of the next transaction.
        automatic_layers.discardDeferredDecision();
        if (automatic_requested) automatic_layers.resume();
    }

    struct PendingLayerSwitch {
        std::uint64_t video_track_id = 0;
        std::uint64_t audio_track_id = 0;
        std::uint64_t previous_video_track_id = 0;
        std::uint64_t previous_audio_track_id = 0;
        std::int64_t earliest_presentation_time_us = 0;
        std::optional<std::int64_t> video_boundary_us;
        MseLayerSwitchReason reason = MseLayerSwitchReason::Manual;
        bool map_to_playback_entry = false;
    };

    void synchronize_audio_timestamp_offsets() noexcept {
        for (auto& entry : audio) {
            entry.second.set_source_buffer_timestamp_offset(
                mse_timestamp_offset_us);
        }
    }

    void push_selected_video(const aribtlv::AccessUnit& unit) {
        if (unit.discontinuity && !video.is_input_track_switch(unit) &&
            !(pending_layer && unit.track_id == pending_layer->video_track_id) &&
            !aribtlv::hasDiscontinuityReason(
                unit.discontinuity_reasons,
                aribtlv::DiscontinuityReason::SourceDamage)) {
            // A damaged selected video layer is independent from AAC packet
            // continuity. Keep active and alternate audio intact so a missing
            // video interval cannot manufacture Chromium audio underflow.
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
    std::int64_t mse_timestamp_offset_us = 0;
    bool enabled = true;
    bool recorded_seek_active = false;
    bool automatic_requested = false;
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
    return impl_->switch_layer(video_track_id, audio_track_id,
        earliest_presentation_time_us, MseLayerSwitchReason::Manual, true);
}

bool tlvdemux::MseRemuxer::switchLayerAtPlaybackEntry(
    const std::uint64_t video_track_id, const std::uint64_t audio_track_id,
    const std::int64_t playback_entry_time_us) {
    return impl_->switch_layer(video_track_id, audio_track_id,
        playback_entry_time_us, MseLayerSwitchReason::Manual, true, true);
}

void tlvdemux::MseRemuxer::configureAutomaticLayerSwitch(
    const MseAutomaticLayerPair pair) {
    impl_->automatic_requested = true;
    // Re-enabling automatic selection supersedes an unfinished user-requested
    // layer switch. Restore the still-active layer before installing the
    // automatic pair; the public coordinator can then decide whether a
    // completed rainfall selection needs an immediate preferred-layer return.
    if (impl_->pending_layer &&
        impl_->pending_layer->reason == MseLayerSwitchReason::Manual) {
        impl_->cancel_layer(MseLayerSwitchCancelReason::SelectionChanged);
    }
    impl_->automatic_layers.configure(VideoLayerPair{
        pair.preferred_video_track_id,
        pair.preferred_audio_track_id,
        pair.fallback_video_track_id,
        pair.fallback_audio_track_id,
    });
    if (impl_->recorded_seek_active) {
        impl_->automatic_layers.suspend();
        return;
    }
    const auto automatic = impl_->automatic_layers.reevaluate();
    impl_->begin_automatic_switch(
        automatic.switch_request,
        automatic.switch_reason == VideoLayerSwitchReason::SourceDamage
            ? MseLayerSwitchReason::SourceDamage
            : MseLayerSwitchReason::HealthDegradation);
}

void tlvdemux::MseRemuxer::suspendAutomaticLayerSwitch(
    const MseAutomaticLayerPair pair) {
    impl_->automatic_requested = false;
    impl_->automatic_layers.configure(VideoLayerPair{
        pair.preferred_video_track_id,
        pair.preferred_audio_track_id,
        pair.fallback_video_track_id,
        pair.fallback_audio_track_id,
    });
    impl_->automatic_layers.suspend();
}

void tlvdemux::MseRemuxer::clearAutomaticLayerSwitch() {
    impl_->automatic_requested = false;
    impl_->automatic_layers.clearConfiguration();
}

void tlvdemux::MseRemuxer::setTimestampOffset(
    const std::int64_t timestamp_offset_us) {
    impl_->mse_timestamp_offset_us = timestamp_offset_us;
    impl_->synchronize_audio_timestamp_offsets();
}

void tlvdemux::MseRemuxer::setRecordedSeekConcealmentTarget(
    const std::optional<std::int64_t> presentation_time_us) {
    impl_->video.set_recorded_seek_concealment_target(presentation_time_us);
}

void tlvdemux::MseRemuxer::beginMseRecordedSeek() {
    impl_->begin_recorded_seek();
}

void tlvdemux::MseRemuxer::finishMseRecordedSeek(
    const std::int64_t playback_position_us) {
    impl_->finish_recorded_seek(playback_position_us);
}

void tlvdemux::MseRemuxer::cancelMseRecordedSeek() {
    impl_->cancel_recorded_seek();
}

void tlvdemux::MseRemuxer::setPlaybackPosition(
    const std::int64_t presentation_time_us) {
    impl_->automatic_layers.setPlaybackPosition(
        presentation_time_us - impl_->mse_timestamp_offset_us);
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

std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted>
tlvdemux::MseRemuxer::push(const AccessUnit& unit) { return impl_->push(unit); }
std::optional<tlvdemux::MseAutomaticLayerSwitchAccepted>
tlvdemux::MseRemuxer::observeDamage(const aribtlv::DamageSpan& damage) {
    return impl_->observe_damage(damage);
}
void tlvdemux::MseRemuxer::flush() { impl_->flush(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::endOfStream() { return impl_->end_of_stream(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reset() { return impl_->reset(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reposition() { return impl_->reposition(); }
