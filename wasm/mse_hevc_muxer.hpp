class HevcMuxer final : public BaseMuxer {
public:
    explicit HevcMuxer(Output& output) : BaseMuxer("video", 1, output), output_(output) {}

    bool started() const noexcept { return started_; }
    bool output_started() const noexcept { return output_started_; }
    bool audio_output_ready() const noexcept {
        return started_ || recovery_observation_eligible_;
    }
    void mark_output_not_started() noexcept {
        output_started_ = false;
        recovery_observation_eligible_ = false;
    }
    const VideoContinuitySnapshot& continuity_snapshot() const noexcept {
        return continuity_.snapshot();
    }
    void set_source_buffer_timestamp_offset(const std::int64_t offset_us) noexcept {
        source_buffer_timestamp_offset_us_ = offset_us;
    }
    void set_recorded_continuity_enabled(const bool enabled) noexcept {
        recorded_continuity_enabled_ = enabled;
        if (!enabled) {
            continuity_.reset();
            frozen_next_pts_ticks_.reset();
        }
    }
    void configure_recorded_video_layers(
        const std::uint64_t preferred_track_id,
        const std::uint64_t fallback_track_id) noexcept {
        preferred_video_track_id_ = preferred_track_id;
        fallback_video_track_id_ = fallback_track_id;
    }
    void clear_recorded_video_layers() noexcept {
        preferred_video_track_id_.reset();
        fallback_video_track_id_.reset();
        fallback_video_committed_ = false;
    }
    void set_sdr_in_hlg(const std::uint64_t track_id, const bool enabled) {
        const auto previous = color_policy(track_id);
        if (enabled) sdr_in_hlg_tracks_.insert(track_id);
        else sdr_in_hlg_tracks_.erase(track_id);
        if (enabled) hlg_sdr_prototype_tracks_.erase(track_id);
        if (previous != color_policy(track_id) && track_ &&
            input_track_id_.has_value() && *input_track_id_ == track_id) {
            configuration_policy_dirty_ = true;
        }
    }
    void set_hlg_sdr_prototype(const std::uint64_t track_id, const bool enabled) {
        const auto previous = color_policy(track_id);
        if (enabled) hlg_sdr_prototype_tracks_.insert(track_id);
        else hlg_sdr_prototype_tracks_.erase(track_id);
        if (enabled) sdr_in_hlg_tracks_.erase(track_id);
        if (previous != color_policy(track_id) && track_ &&
            input_track_id_.has_value() && *input_track_id_ == track_id) {
            configuration_policy_dirty_ = true;
        }
    }
    void set_video_signalling(const std::uint64_t track_id,
                              const tlvdemux::MseVideoSignalling signalling) {
        video_signalling_[track_id] = signalling;
        if (track_ && input_track_id_.has_value() && *input_track_id_ == track_id) {
            configuration_policy_dirty_ = true;
        }
    }
    void set_recorded_seek_concealment_target(
        const std::optional<std::int64_t> target_us) noexcept {
        recorded_seek_concealment_target_us_ = target_us;
        concealment_episode_marker_start_us_.reset();
        concealment_episode_start_us_.reset();
        concealment_pending_stable_rap_ = false;
    }
    bool is_input_track_switch(const aribtlv::AccessUnit& unit) const noexcept {
        return unit.discontinuity && input_track_id_.has_value() &&
            *input_track_id_ != unit.track_id;
    }
    std::optional<std::int64_t> take_splice_boundary_us() noexcept {
        return std::exchange(splice_boundary_us_, std::nullopt);
    }
    void stage_next_switch(
        const std::optional<std::uint64_t> fallback_track_id = std::nullopt,
        const bool preserve_continuity = false) noexcept {
        if (fallback_track_id) continuity_.awaitFallback(*fallback_track_id);
        else if (!preserve_continuity) continuity_.reset();
        source_damage_observation_ = SourceDamageObservation::None;
        recovery_candidate_rejected_ = false;
        recovery_episode_reported_ = false;
        recovery_observation_eligible_ = false;
        stage_next_switch_ = true;
        restoring_layer_switch_ = preserve_continuity &&
            continuity_.phase() == VideoContinuityPhase::Restoring;
    }
    void cancel_staged_switch() noexcept { stage_next_switch_ = false; }
    void retry_staged_switch() noexcept {
        reset_samples();
        started_ = false;
        output_started_ = false;
        recovery_observation_eligible_ = false;
        no_rasl_output_ = false;
        sequence_start_ = true;
        splice_boundary_us_.reset();
        continuity_.reset();
        source_damage_observation_ = SourceDamageObservation::None;
        recovery_candidate_rejected_ = false;
        recovery_episode_reported_ = false;
        stage_next_switch_ = true;
    }
    // AacMuxer has its own (sample-rate) track timescale, so it needs this
    // shared offset in microseconds regardless of the video track timescale.
    std::optional<std::int64_t> timeline_offset_us() const noexcept {
        if (!timeline_offset_ticks_) return std::nullopt;
        return scaled(*timeline_offset_ticks_, track_->timescale, 1000000);
    }
    bool repeat_last_closed_picture(const std::int64_t start_time_us,
                                    const std::int64_t end_time_us) {
        if (!last_closed_picture_ || end_time_us <= start_time_us) return false;
        if (!track_) replace_track(last_closed_picture_->track);
        started_ = true;
        recovery_observation_eligible_ = true;
        const auto offset = timeline_offset_ticks_.value_or(0);
        auto pts = scaled(start_time_us, 1000000, track_->timescale) + offset;
        const auto end_pts = scaled(end_time_us, 1000000, track_->timescale) + offset;
        const auto duration = std::max<std::int64_t>(1, default_duration());
        while (pts < end_pts) {
            auto data = last_closed_picture_->data;
            const auto dts = pts - last_closed_picture_->composition_offset;
            if (dts < 0) return false;
            if (!enqueue({std::move(data), dts, pts, 0, true})) return false;
            pts = std::min(end_pts, pts + duration);
        }
        flush_at(end_pts - last_closed_picture_->composition_offset);
        return true;
    }
    bool extend_frozen_through(const std::int64_t aac_frontier_us) {
        continuity_.noteAacFrontier(aac_frontier_us);
        if (!recorded_continuity_enabled_ || fallback_video_committed_ ||
            (continuity_.phase() != VideoContinuityPhase::Frozen &&
             continuity_.phase() != VideoContinuityPhase::FallbackPending) ||
            !last_closed_picture_ || !track_) return false;
        if (!frozen_next_pts_ticks_) {
            const auto start_us = last_video_source_end_us_
                .value_or(continuity_.snapshot().damage_start_us.value_or(aac_frontier_us));
            frozen_next_pts_ticks_ = scaled(start_us, 1000000, track_->timescale);
        }
        const auto frontier = scaled(aac_frontier_us, 1000000, track_->timescale);
        const auto duration = std::max<std::int64_t>(1, default_duration());
        while (*frozen_next_pts_ticks_ < frontier) {
            const auto pts = *frozen_next_pts_ticks_;
            const auto dts = pts - last_closed_picture_->composition_offset;
            if (dts < 0) return false;
            auto data = last_closed_picture_->data;
            if (!enqueue({std::move(data), dts, pts, 0, true})) return false;
            *frozen_next_pts_ticks_ += duration;
        }
        const auto through_us = scaled(
            *frozen_next_pts_ticks_, track_->timescale, 1000000);
        continuity_.noteFrozenThrough(through_us);
        started_ = true;
        recovery_observation_eligible_ = true;
        return true;
    }
    std::optional<std::int64_t> observe_preferred_candidate(
        const aribtlv::AccessUnit& unit) {
        if (!recorded_continuity_enabled_ || !fallback_video_committed_ ||
            !preferred_video_track_id_ || unit.track_id != *preferred_video_track_id_ ||
            unit.codec != aribtlv::Codec::Hevc || unit.pts.timescale <= 1) {
            return std::nullopt;
        }
        const auto pts_us = scaled(unit.pts.value, unit.pts.timescale, 1000000);
        const bool source_damage = unit.discontinuity &&
            aribtlv::hasDiscontinuityReason(
                unit.discontinuity_reasons,
                aribtlv::DiscontinuityReason::SourceDamage);
        const auto previous_phase = continuity_.phase();
        const auto decision = continuity_.observePreferred(
            pts_us, unit.random_access, source_damage);
        if (previous_phase == VideoContinuityPhase::FallbackPending &&
            continuity_.phase() == VideoContinuityPhase::PreferredCandidate) {
            output_.video_recovery(recovery_event(
                unit.track_id, pts_us,
                tlvdemux::MseVideoRecoveryPhase::ObservationStarted));
        }
        if (decision == PreferredContinuityDecision::CandidateRejected) {
            output_.video_recovery(recovery_event(
                unit.track_id, pts_us,
                tlvdemux::MseVideoRecoveryPhase::CandidateRejected));
        }
        if (decision == PreferredContinuityDecision::Restore) return pts_us;
        return std::nullopt;
    }
    void complete_source_damage_layer_switch(
        const std::uint64_t track_id, const std::int64_t boundary_us) {
        if (preferred_video_track_id_ && track_id == *preferred_video_track_id_ &&
            restoring_layer_switch_) {
            output_.video_recovery(recovery_event(
                track_id, boundary_us,
                tlvdemux::MseVideoRecoveryPhase::StableRapCommitted));
            continuity_.completeRestoration();
            fallback_video_committed_ = false;
            restoring_layer_switch_ = false;
            frozen_next_pts_ticks_.reset();
            return;
        }
        if (fallback_video_track_id_ && track_id == *fallback_video_track_id_) {
            continuity_.awaitFallback(track_id);
            fallback_video_committed_ = true;
            output_.video_recovery(recovery_event(
                track_id, boundary_us,
                tlvdemux::MseVideoRecoveryPhase::ObservationStarted));
        }
    }
    void clear_last_closed_picture() noexcept { last_closed_picture_.reset(); }
    void observe_source_damage(const aribtlv::DamageSpan& damage) {
        if (damage.kind != aribtlv::TrackKind::Video ||
            !input_track_id_ || damage.track_id != *input_track_id_ ||
            (!recovery_observation_eligible_ &&
             !recorded_seek_concealment_target_us_) ||
            !aribtlv::hasDiscontinuityReason(
                damage.reasons, aribtlv::DiscontinuityReason::SourceDamage)) return;
        const auto timestamp = damage.start_time.value_or(damage.end_time);
        const auto start_us = scaled(timestamp.value, timestamp.timescale, 1000000);
        if (recorded_continuity_enabled_) {
            continuity_.sealDamage(start_us);
            continuity_.freeze();
        }
        if (recorded_seek_concealment_target_us_ &&
            concealment_episode_marker_start_us_ &&
            !concealment_episode_start_us_) {
            concealment_episode_start_us_ = start_us;
        }
        if (!recovery_episode_reported_) {
            // DamageSpan is the canonical merged episode boundary. Diagnostics
            // use the transport's 10 ms loss-window precision rather than the
            // first arbitrary damaged access unit that happened to reach MSE.
            const auto boundary_us = start_us >= 0
                ? start_us / 10000 * 10000
                : start_us;
            output_.video_recovery(recovery_event(
                damage.track_id, boundary_us,
                tlvdemux::MseVideoRecoveryPhase::ObservationStarted));
            recovery_episode_reported_ = true;
        } else if (recovery_candidate_rejected_) {
            output_.video_recovery(recovery_event(
                damage.track_id, start_us,
                tlvdemux::MseVideoRecoveryPhase::CandidateRejected));
            recovery_candidate_rejected_ = false;
        }
    }

    void reset(const bool clear_policy = false) {
        reset_samples();
        parameter_sets_.clear();
        active_hdr_static_metadata_.reset();
        track_.reset();
        started_ = false;
        output_started_ = false;
        recovery_observation_eligible_ = false;
        no_rasl_output_ = false;
        sequence_start_ = true;
        timeline_offset_ticks_.reset();
        input_track_id_.reset();
        splice_boundary_us_.reset();
        stage_next_switch_ = false;
        restoring_layer_switch_ = false;
        fallback_video_committed_ = false;
        continuity_.reset();
        frozen_next_pts_ticks_.reset();
        last_video_source_end_us_.reset();
        source_damage_observation_ = SourceDamageObservation::None;
        recovery_candidate_rejected_ = false;
        recovery_episode_reported_ = false;
        recorded_seek_concealment_target_us_.reset();
        concealment_episode_marker_start_us_.reset();
        concealment_episode_start_us_.reset();
        concealment_pending_stable_rap_ = false;
        configuration_policy_dirty_ = false;
        current_video_properties_.reset();
        if (clear_policy) {
            sdr_in_hlg_tracks_.clear();
            hlg_sdr_prototype_tracks_.clear();
            video_signalling_.clear();
        }
    }

    void push(const aribtlv::AccessUnit& unit, const bool output_enabled) {
        splice_boundary_us_.reset();
        const auto nalus = annex_b_views(unit.data);
        if (const auto metadata = hdr_static_metadata(unit.data)) {
            active_hdr_static_metadata_ = metadata;
        }
        bool has_parameter_set = false;
        for (const auto& nalu : nalus) {
            if (nalu.type >= 32 && nalu.type <= 34) {
                parameter_sets_[nalu.type] = copy_nalu(unit.data, nalu);
                has_parameter_set = true;
            }
        }

        bool has_vcl = false;
        bool only_rasl_vcl = true;
        bool all_leading = true;
        bool has_eos = false;
        int irap = -1;
        for (const auto& nalu : nalus) {
            if (nalu.type >= 0 && nalu.type <= 31) {
                has_vcl = true;
                only_rasl_vcl = only_rasl_vcl && (nalu.type == 8 || nalu.type == 9);
                all_leading = all_leading && (nalu.type >= 6 && nalu.type <= 9);
                if (nalu.type >= 16 && nalu.type <= 21 && irap < 0) irap = nalu.type;
            } else if (nalu.type == 36 || nalu.type == 37) {
                has_eos = true;
            }
        }
        const bool source_damage = unit.discontinuity &&
            aribtlv::hasDiscontinuityReason(
                unit.discontinuity_reasons,
                aribtlv::DiscontinuityReason::SourceDamage);
        const bool track_switch_boundary = input_track_id_.has_value() &&
            *input_track_id_ != unit.track_id && irap >= 0;
        const bool requested_switch_boundary =
            stage_next_switch_ && irap >= 0;
        const bool observe_source_damage = source_damage &&
            (recovery_observation_eligible_ ||
             recorded_seek_concealment_target_us_.has_value()) &&
            !track_switch_boundary && !requested_switch_boundary;
        if (track_switch_boundary || requested_switch_boundary) {
            if (continuity_.phase() != VideoContinuityPhase::FallbackPending &&
                continuity_.phase() != VideoContinuityPhase::Restoring) {
                continuity_.reset();
            }
            frozen_next_pts_ticks_.reset();
            source_damage_observation_ = SourceDamageObservation::None;
            recovery_candidate_rejected_ = false;
            recovery_episode_reported_ = false;
        } else if (unit.discontinuity && !source_damage) {
            // Reposition and genuine epoch changes keep their existing
            // first-RAP startup contract; they are not source recovery.
            continuity_.reset();
            frozen_next_pts_ticks_.reset();
            source_damage_observation_ = SourceDamageObservation::None;
            recovery_candidate_rejected_ = false;
            recovery_episode_reported_ = false;
        } else if (observe_source_damage) {
            if (!input_track_id_ && recorded_seek_concealment_target_us_) {
                input_track_id_ = unit.track_id;
            }
            const auto previous_observation = source_damage_observation_;
            const auto unit_pts_us = scaled(
                unit.pts.value, unit.pts.timescale, 1000000);
            if (source_damage_observation_ == SourceDamageObservation::None) {
                // Preserve every complete picture before the loss. Candidate
                // GOPs are never enqueued, so observation cannot enlarge the
                // fragment queue or the browser transition budget.
                if (recorded_seek_concealment_target_us_) {
                    // Emit the normal prefix but retain exactly its final
                    // sample. If this episode contains the one-shot seek
                    // target, the stable RAP will provide its real decode
                    // boundary; otherwise it is later sealed normally.
                    emit_ready_keeping_pending();
                    concealment_episode_marker_start_us_ = scaled(
                        unit.pts.value, unit.pts.timescale, 1000000);
                    concealment_episode_start_us_.reset();
                    if (!recovery_episode_reported_) {
                        output_.video_recovery(recovery_event(
                            unit.track_id, *concealment_episode_marker_start_us_,
                            tlvdemux::MseVideoRecoveryPhase::ObservationStarted));
                        recovery_episode_reported_ = true;
                    }
                } else {
                    flush();
                }
            } else if (previous_observation == SourceDamageObservation::CandidateGop) {
                recovery_candidate_rejected_ = true;
            }
            if (recorded_continuity_enabled_) {
                continuity_.sealDamage(unit_pts_us);
                continuity_.freeze();
                if (previous_observation == SourceDamageObservation::CandidateGop) {
                    continuity_.observePreferred(unit_pts_us, irap >= 0, true);
                }
            }
            started_ = false;
            no_rasl_output_ = false;
            sequence_start_ = true;
            configuration_policy_dirty_ = true;
            // A RAP carrying the same damage marker is only the decoder's
            // immediate restart point. It is not evidence of one complete,
            // clean candidate GOP.
            source_damage_observation_ =
                (previous_observation == SourceDamageObservation::CandidateGop ||
                 recorded_seek_concealment_target_us_) && irap >= 0 && has_vcl
                ? SourceDamageObservation::CandidateGop
                : SourceDamageObservation::WaitingForRap;
            return;
        } else if (source_damage_observation_ ==
                   SourceDamageObservation::WaitingForRap) {
            if (irap >= 0 && has_vcl) {
                source_damage_observation_ = SourceDamageObservation::CandidateGop;
                if (recorded_continuity_enabled_) {
                    continuity_.observePreferred(
                        scaled(unit.pts.value, unit.pts.timescale, 1000000),
                        true, false);
                }
            }
            return;
        } else if (source_damage_observation_ ==
                   SourceDamageObservation::CandidateGop) {
            if (irap < 0 || !has_vcl) return;
            // A complete candidate GOP reached its next real RAP without a
            // new source-damage marker. Restart at this boundary; the observed
            // GOP itself was intentionally discarded rather than cached.
            source_damage_observation_ = SourceDamageObservation::None;
            if (recorded_continuity_enabled_) {
                continuity_.observePreferred(
                    scaled(unit.pts.value, unit.pts.timescale, 1000000), true, false);
            }
            recovery_candidate_rejected_ = false;
            recovery_episode_reported_ = false;
            output_.video_recovery(recovery_event(
                unit.track_id,
                scaled(unit.pts.value, unit.pts.timescale, 1000000),
                tlvdemux::MseVideoRecoveryPhase::StableRapCommitted));
            if (recorded_seek_concealment_target_us_) {
                const auto stable_rap_us = scaled(
                    unit.pts.value, unit.pts.timescale, 1000000);
                const auto episode_start_us = concealment_episode_start_us_
                    .value_or(concealment_episode_marker_start_us_
                        .value_or(stable_rap_us));
                concealment_pending_stable_rap_ =
                    *recorded_seek_concealment_target_us_ >= episode_start_us &&
                    *recorded_seek_concealment_target_us_ < stable_rap_us;
                if (!concealment_pending_stable_rap_) {
                    // Delayed only to decide whether this was the target's
                    // episode; emit the retained picture exactly as ordinary
                    // recovery would have done at the first marker.
                    flush();
                    concealment_episode_marker_start_us_.reset();
                    concealment_episode_start_us_.reset();
                }
            }
            if (recorded_continuity_enabled_ && frozen_next_pts_ticks_ && track_) {
                const auto raw_pts = scaled(
                    unit.pts.value, unit.pts.timescale, track_->timescale);
                timeline_offset_ticks_ = *frozen_next_pts_ticks_ - raw_pts;
                const auto boundary_us = scaled(
                    *frozen_next_pts_ticks_, track_->timescale, 1000000);
                output_.video_splice(boundary_us, source_buffer_timestamp_offset_us_);
            }
        }
        if (requested_switch_boundary && !track_) {
            // Startup switching can reach the fallback configuration before a
            // preferred video SourceBuffer exists. Begin staging before the
            // target track is installed so no target init escapes ahead of the
            // logical splice.
            output_.begin_video_staging();
            stage_next_switch_ = false;
        }
        bool configuration_boundary = false;
        bool deferred_initial_properties = false;
        if (parameter_sets_.count(32) != 0 && parameter_sets_.count(33) != 0 &&
            parameter_sets_.count(34) != 0) {
            const auto config = hevc_configuration(
                parameter_sets_[32], parameter_sets_[33], parameter_sets_[34],
                color_policy(unit.track_id), active_hdr_static_metadata_);
            auto candidate = video_track(config, unit);
            const auto properties = video_properties(config, unit);
            if (!track_) {
                set_track(std::move(candidate), !requested_switch_boundary);
                if (requested_switch_boundary) {
                    current_video_properties_ = properties;
                    deferred_initial_properties = true;
                } else {
                    emit_video_properties(properties);
                }
            } else if ((has_parameter_set || configuration_policy_dirty_) && irap >= 0 &&
                       configuration_differs(candidate)) {
                if (output_enabled && !output_.supports_video_reconfiguration()) {
                    throw std::runtime_error(
                        "HEVC configuration changes require SeparateTracks MSE output");
                }
                const auto input_boundary_dts = scaled(
                    unit.dts.value, unit.dts.timescale, track_->timescale);
                if (!timeline_offset_ticks_) {
                    timeline_offset_ticks_ = std::max<std::int64_t>(0, -input_boundary_dts);
                }
                const auto offset = *timeline_offset_ticks_;
                const auto boundary_dts = input_boundary_dts + offset;
                const auto boundary_pts = scaled(unit.pts.value, unit.pts.timescale,
                                                 track_->timescale) + offset;
                flush_at(boundary_dts);
                if (stage_next_switch_) {
                    output_.begin_video_staging();
                    stage_next_switch_ = false;
                }
                splice_boundary_us_ = scaled(boundary_pts, track_->timescale, 1000000);
                output_.video_splice(*splice_boundary_us_);
                candidate.timescale = track_->timescale;
                replace_track(std::move(candidate));
                emit_video_properties(properties);
                started_ = false;
                no_rasl_output_ = false;
                sequence_start_ = true;
                configuration_boundary = true;
            } else if ((has_parameter_set || configuration_policy_dirty_) && irap >= 0 &&
                       video_properties_differ(properties)) {
                emit_video_properties(properties);
            }
            if (configuration_policy_dirty_ && irap >= 0) {
                configuration_policy_dirty_ = false;
            }
        }
        if ((track_switch_boundary || requested_switch_boundary) &&
            !configuration_boundary) {
            const auto input_boundary_dts = scaled(
                unit.dts.value, unit.dts.timescale, track_->timescale);
            if (!timeline_offset_ticks_) {
                timeline_offset_ticks_ = std::max<std::int64_t>(0, -input_boundary_dts);
            }
            const auto offset = *timeline_offset_ticks_;
            const auto boundary_dts = input_boundary_dts + offset;
            const auto boundary_pts = scaled(unit.pts.value, unit.pts.timescale,
                                             track_->timescale) + offset;
            flush_at(boundary_dts);
            if (stage_next_switch_) {
                output_.begin_video_staging();
                stage_next_switch_ = false;
            }
            splice_boundary_us_ = scaled(boundary_pts, track_->timescale, 1000000);
            output_.video_splice(*splice_boundary_us_);
            // A layer-switch attempt is a self-contained decoder transition.
            // This is required even when the codec string and hvcC happen to
            // match, and especially after a discarded staging attempt has
            // already installed the target configuration internally.
            if (requested_switch_boundary) {
                emit_init();
                if (deferred_initial_properties && current_video_properties_) {
                    output_.video_properties(*current_video_properties_);
                }
            }
            started_ = false;
            no_rasl_output_ = false;
            sequence_start_ = true;
            configuration_boundary = true;
        }
        if (unit.discontinuity && !configuration_boundary) {
            // A source-loss marker belongs to the following input AU, not to
            // complete samples queued before it. Seal that valid prefix before
            // waiting for a recovery IRAP. Clearing every short prefix here
            // leaves SourceBuffer with audio but no decodable video.
            // A genuine epoch change invalidates both the queued generation
            // and its old source-to-output mapping. Mid-stream source damage
            // returned through the bounded observation path above. At fresh
            // startup, however, SourceDamage keeps the ordinary first-RAP
            // contract and reaches this path before observation is eligible.
            reset_samples();
            timeline_offset_ticks_.reset();
            started_ = false;
            recovery_observation_eligible_ = false;
            no_rasl_output_ = false;
            sequence_start_ = true;
        }
        if (!track_) return;
        if (!has_vcl) {
            // An EOS/EOB-only access unit carries no picture, but still ends
            // the coded video sequence for whichever IRAP follows it.
            if (has_eos) sequence_start_ = true;
            return;
        }
        if (!started_) {
            if (irap < 0) return;
            started_ = true;
            if (!configuration_boundary) {
                const auto first_dts = scaled(unit.dts.value, unit.dts.timescale, track_->timescale);
                timeline_offset_ticks_ = std::max<std::int64_t>(0, -first_dts);
            }
            output_.video_start(irap, unit.random_access);
            input_track_id_ = unit.track_id;
        }
        // HEVC 8.1.3: NoRaslOutputFlag is 1 for every IDR/BLA access unit, and for
        // a CRA that opens a fresh coded video sequence (the first access unit in
        // the bitstream, or the first one after an EOS/EOB NAL); HandleCraAsBlaFlag
        // is an external decoder input, not derivable from the bitstream, and is
        // ignored. While it holds, RASL pictures reference data the decoder never
        // received and are dropped. RADL pictures are leading but decodable, so
        // they pass through without closing the window; the window instead ends at
        // the first trailing (non-leading) access unit that follows the IRAP.
        if (irap >= 0) {
            no_rasl_output_ = (irap >= 16 && irap <= 20) || sequence_start_;
            sequence_start_ = false;
        } else if (no_rasl_output_) {
            if (only_rasl_vcl) return;
            if (!all_leading) no_rasl_output_ = false;
        }
        if (has_eos) sequence_start_ = true;

        std::size_t output_size = 0;
        for (const auto& nalu : nalus) {
            if (included_in_sample(nalu)) output_size += 4U + nalu.size;
        }
        Bytes data;
        data.reserve(output_size);
        for (const auto& nalu : nalus) {
            if (!included_in_sample(nalu)) continue;
            append(data, u32(nalu.size));
            append(data, unit.data.data() + nalu.offset, nalu.size);
        }
        if (data.empty()) return;
        const auto offset = timeline_offset_ticks_.value_or(0);
        const auto dts = scaled(unit.dts.value, unit.dts.timescale, track_->timescale) + offset;
        const auto pts = scaled(unit.pts.value, unit.pts.timescale, track_->timescale) + offset;
        if (dts < 0) return;
        // A CRA (type 21) is a decodable random-access picture when this muxer
        // starts a fresh sequence at a byte landing: RASL is discarded above,
        // while the CRA payload itself is self-decodable.  Retain it as the
        // prior usable picture as well as IDR/BLA so an audio-first Recorded
        // transaction can bridge a high-bitrate GOP without copying a future
        // frame backward or exceeding its 16 MiB read budget.
        if (irap >= 16 && irap <= 21) {
            last_closed_picture_ = FrozenPicture{data, pts - dts, *track_};
        }
        if (!output_enabled) return;
        if (concealment_pending_stable_rap_) {
            if (!has_pending_sample()) {
                const auto target_pts = scaled(
                    *recorded_seek_concealment_target_us_, 1000000,
                    track_->timescale) + offset;
                const auto composition_offset = pts - dts;
                const auto target_dts = target_pts - composition_offset;
                if (target_dts >= 0 && target_dts < dts) {
                    auto filler = data;
                    enqueue({std::move(filler), target_dts, target_pts, 0, true});
                }
            }
            // With a retained pre-damage sample, ordinary enqueue seals its
            // trun duration at this stable decode boundary. With no earlier
            // sample, the duplicate RAP above is sealed here and the original
            // RAP remains at its unmodified DTS/PTS.
            concealment_pending_stable_rap_ = false;
            recorded_seek_concealment_target_us_.reset();
            concealment_episode_marker_start_us_.reset();
            concealment_episode_start_us_.reset();
        }
        if (enqueue({std::move(data), dts, pts, 0, irap >= 0})) {
            recovery_observation_eligible_ = true;
            if (continuity_.phase() == VideoContinuityPhase::Restoring &&
                !restoring_layer_switch_) {
                continuity_.completeRestoration();
                frozen_next_pts_ticks_.reset();
            }
        }
    }

private:
    struct FrozenPicture {
        Bytes data;
        std::int64_t composition_offset = 0;
        Mp4Track track;
    };

    tlvdemux::MseVideoRecoveryEvent recovery_event(
        const std::uint64_t track_id, const std::int64_t presentation_time_us,
        const tlvdemux::MseVideoRecoveryPhase phase) const {
        const auto& snapshot = continuity_.snapshot();
        tlvdemux::MseVideoRecoveryEvent event;
        event.video_track_id = track_id;
        event.presentation_time_us = presentation_time_us;
        event.phase = phase;
        event.continuity_state = video_continuity_phase_name(snapshot.phase);
        event.damage_start_us = snapshot.damage_start_us;
        event.aac_frontier_us = snapshot.aac_frontier_us;
        event.frozen_through_us = snapshot.frozen_through_us;
        event.candidate_rap_us = snapshot.candidate_rap_us;
        event.fallback_track_id = snapshot.fallback_track_id;
        event.last_video_output_end_us = snapshot.last_video_output_end_us;
        return event;
    }

    enum class SourceDamageObservation {
        None,
        WaitingForRap,
        CandidateGop,
    };

    void on_segment_emitted(const std::vector<Sample>& samples) override {
        if (samples.empty() || !track_) return;
        output_started_ = true;
        auto end = samples.front().pts +
            static_cast<std::int64_t>(samples.front().duration);
        for (const auto& sample : samples) {
            end = std::max(end, sample.pts + static_cast<std::int64_t>(sample.duration));
        }
        last_video_source_end_us_ = scaled(end, track_->timescale, 1000000);
        continuity_.noteVideoOutputEnd(
            *last_video_source_end_us_ + source_buffer_timestamp_offset_us_);
    }

    HevcColorPolicy color_policy(const std::uint64_t track_id) const noexcept {
        if (hlg_sdr_prototype_tracks_.count(track_id) != 0) {
            return HevcColorPolicy::HlgSdrPrototype;
        }
        if (sdr_in_hlg_tracks_.count(track_id) != 0) {
            return HevcColorPolicy::SdrInHlg;
        }
        return HevcColorPolicy::Preserve;
    }

    static tlvdemux::MseVideoColor video_color(const ColorInformation& color) {
        return {color.primaries, color.transfer, color.matrix, color.full_range};
    }

    static tlvdemux::MseHdrStaticMetadata mse_hdr_static_metadata(
        const HdrStaticMetadata& metadata) {
        return {metadata.display_primaries_x, metadata.display_primaries_y,
                metadata.white_point_x, metadata.white_point_y,
                metadata.max_display_mastering_luminance,
                metadata.min_display_mastering_luminance,
                metadata.max_content_light_level,
                metadata.max_pic_average_light_level,
                metadata.has_mastering_display, metadata.has_content_light};
    }

    tlvdemux::MseVideoProperties video_properties(
        const HevcConfiguration& config, const aribtlv::AccessUnit& unit) {
        tlvdemux::MseVideoProperties properties;
        properties.track_id = unit.track_id;
        properties.presentation_time_us = scaled(
            unit.pts.value, unit.pts.timescale, 1000000);
        properties.width = config.width;
        properties.height = config.height;
        properties.codec = config.codec;
        if (config.source_color) properties.source_color = video_color(*config.source_color);
        if (config.color) properties.output_color = video_color(*config.color);
        if (config.hdr_static_metadata) {
            properties.hdr_static_metadata =
                mse_hdr_static_metadata(*config.hdr_static_metadata);
        }
        if (const auto signalling = video_signalling_.find(unit.track_id);
            signalling != video_signalling_.end()) {
            properties.source_signalling = signalling->second;
            if (signalling->second.video_transfer_characteristics &&
                config.source_color) {
                const auto cicp = aribtlv::cicp_transfer_from_b60(
                    *signalling->second.video_transfer_characteristics);
                properties.source_signalling_mismatch = cicp.has_value() &&
                    static_cast<std::uint16_t>(*cicp) != config.source_color->transfer;
            }
        }
        constexpr auto hlg = static_cast<std::uint16_t>(
            aribtlv::VideoTransferCharacteristics::AribHlg);
        properties.sdr_in_hlg = config.source_color.has_value() &&
            config.color.has_value() && config.source_color->transfer == hlg &&
            *config.color == ColorInformation{
                aribtlv::kCicpBt2020Primaries,
                aribtlv::kCicpBt709Primaries,
                aribtlv::kCicpBt2020NclMatrix,
                false};
        properties.hlg_sdr_prototype = config.source_color.has_value() &&
            config.color.has_value() &&
            aribtlv::is_bt2020_hlg(config.source_color->primaries,
                                   config.source_color->transfer,
                                   config.source_color->matrix,
                                   config.source_color->full_range) &&
            *config.color == ColorInformation{
                aribtlv::kCicpBt709Primaries, 13,
                aribtlv::kCicpBt2020NclMatrix, false};
        return properties;
    }

    bool video_properties_differ(
        const tlvdemux::MseVideoProperties& properties) const {
        return !current_video_properties_.has_value() ||
            current_video_properties_->track_id != properties.track_id ||
            current_video_properties_->width != properties.width ||
            current_video_properties_->height != properties.height ||
            current_video_properties_->codec != properties.codec ||
            current_video_properties_->source_color != properties.source_color ||
            current_video_properties_->output_color != properties.output_color ||
            current_video_properties_->hdr_static_metadata !=
                properties.hdr_static_metadata ||
            current_video_properties_->source_signalling !=
                properties.source_signalling ||
            current_video_properties_->source_signalling_mismatch !=
                properties.source_signalling_mismatch ||
            current_video_properties_->sdr_in_hlg != properties.sdr_in_hlg ||
            current_video_properties_->hlg_sdr_prototype !=
                properties.hlg_sdr_prototype;
    }

    void emit_video_properties(const tlvdemux::MseVideoProperties& properties) {
        current_video_properties_ = properties;
        output_.video_properties(properties);
    }

    static Mp4Track video_track(const HevcConfiguration& config,
                                const aribtlv::AccessUnit& unit) {
        Mp4Track track;
        track.video = true;
        track.width = config.width;
        track.height = config.height;
        track.codec = config.codec;
        track.config = config.hvcc;
        track.color = config.color;
        track.hdr_static_metadata = config.hdr_static_metadata;
        // Adopt the stream's own timescale so DTS/PTS stay exact integers
        // (e.g. 180000's 3003-tick frame interval is not an integer number
        // of microseconds, and the resulting rounding drift can make a
        // fragment's composition interval overlap the next one). A
        // timescale of 1 means the stream never signalled one; keep the
        // 1000000 default rather than build a 1 Hz MP4 track.
        if (unit.dts.timescale > 1) track.timescale = unit.dts.timescale;
        return track;
    }

    bool configuration_differs(const Mp4Track& candidate) const {
        return track_->width != candidate.width || track_->height != candidate.height ||
            track_->codec != candidate.codec || track_->config != candidate.config ||
            track_->color != candidate.color ||
            track_->hdr_static_metadata != candidate.hdr_static_metadata;
    }

    static bool included_in_sample(const NaluView& nalu) noexcept {
        return nalu.type != 32 && nalu.type != 33 && nalu.type != 34 && nalu.type != 35;
    }

    // 33367 at a 1e6 timescale is the ~29.97fps default this stood in for;
    // scale it to whatever timescale the track actually adopted above.
    std::uint32_t default_duration() const override {
        return track_ ? static_cast<std::uint32_t>(std::llround(
                            33367.0 * track_->timescale / 1000000.0))
                      : 33367;
    }

    Output& output_;
    std::map<int, Bytes> parameter_sets_;
    std::optional<HdrStaticMetadata> active_hdr_static_metadata_;
    std::map<std::uint64_t, tlvdemux::MseVideoSignalling> video_signalling_;
    std::set<std::uint64_t> sdr_in_hlg_tracks_;
    std::set<std::uint64_t> hlg_sdr_prototype_tracks_;
    std::optional<tlvdemux::MseVideoProperties> current_video_properties_;
    bool started_ = false;
    bool output_started_ = false;
    bool recovery_observation_eligible_ = false;
    bool no_rasl_output_ = false;
    bool sequence_start_ = true;
    std::optional<std::int64_t> timeline_offset_ticks_;
    std::optional<std::uint64_t> input_track_id_;
    std::optional<std::int64_t> splice_boundary_us_;
    std::optional<FrozenPicture> last_closed_picture_;
    VideoContinuityState continuity_;
    std::optional<std::int64_t> frozen_next_pts_ticks_;
    std::optional<std::int64_t> last_video_source_end_us_;
    std::int64_t source_buffer_timestamp_offset_us_ = 0;
    bool recorded_continuity_enabled_ = false;
    bool stage_next_switch_ = false;
    bool restoring_layer_switch_ = false;
    bool fallback_video_committed_ = false;
    std::optional<std::uint64_t> preferred_video_track_id_;
    std::optional<std::uint64_t> fallback_video_track_id_;
    SourceDamageObservation source_damage_observation_ =
        SourceDamageObservation::None;
    bool recovery_candidate_rejected_ = false;
    bool recovery_episode_reported_ = false;
    std::optional<std::int64_t> recorded_seek_concealment_target_us_;
    std::optional<std::int64_t> concealment_episode_marker_start_us_;
    std::optional<std::int64_t> concealment_episode_start_us_;
    bool concealment_pending_stable_rap_ = false;
    bool configuration_policy_dirty_ = false;
};
