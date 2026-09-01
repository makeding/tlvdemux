class AacMuxer final : public BaseMuxer {
public:
    explicit AacMuxer(Output& output, const std::uint32_t max_channels)
        : BaseMuxer("audio", 2, output), output_(output),
          max_channels_(max_channels) {}

    void discontinuity(const bool preserve_history = false) {
        reset_samples();
        clear_resume();
        if (!preserve_history) {
            history_.clear();
            contiguous_emitted_end_us_.reset();
            timeline_offset_us_.reset();
            source_buffer_timestamp_offset_us_ = 0;
        }
    }

    void activate() {
        clear_resume();
        contiguous_emitted_end_us_.reset();
        BaseMuxer::activate();
    }

    void set_source_buffer_timestamp_offset(
        const std::int64_t timestamp_offset_us) noexcept {
        source_buffer_timestamp_offset_us_ = timestamp_offset_us;
    }

    // Continue this muxer's mapped output timeline at the exact end of the
    // previous audio track. The media timestamps remain in SourceBuffer input
    // coordinates, so remove this muxer's complete absolute timestamp offset
    // before anchoring the first access unit.
    void resume_at(const std::int64_t resume_at_ticks,
                   const std::uint32_t resume_timescale) {
        timestamp_correction_ticks_ = 0;
        resume_at_ticks_ = resume_at_ticks;
        resume_timescale_ = resume_timescale;
        resume_offset_ticks_ = track_.has_value()
            ? std::optional<std::int64_t>(
                scaled(resume_at_ticks, resume_timescale, track_->timescale) -
                scaled(source_buffer_timestamp_offset_us_, 1000000,
                       track_->timescale))
            : std::nullopt;
        resume_origin_ticks_.reset();
        first_after_resume_ = false;
    }

    std::optional<std::int64_t> emitted_timeline_end() const noexcept {
        return contiguous_emitted_end_us_.has_value() && track_.has_value()
            ? std::optional<std::int64_t>{scaled(
                *contiguous_emitted_end_us_, 1000000, track_->timescale)}
            : std::nullopt;
    }

    std::optional<std::uint32_t> track_timescale() const noexcept {
        return track_.has_value() ? std::optional<std::uint32_t>(track_->timescale)
                                  : std::nullopt;
    }

    std::optional<std::uint32_t> track_sample_rate() const noexcept {
        return track_.has_value() ? std::optional<std::uint32_t>(track_->sample_rate)
                                  : std::nullopt;
    }

    std::optional<std::int64_t> activate_from(
        const std::int64_t earliest_presentation_time_us,
        const std::optional<std::int64_t> output_boundary_us = std::nullopt,
        const std::int64_t timestamp_offset_us = 0) {
        if (!track_) return std::nullopt;
        const auto first = std::find_if(history_.begin(), history_.end(),
            [this, earliest_presentation_time_us](const Sample& sample) {
                return scaled(sample.pts, track_->timescale, 1000000) >=
                    earliest_presentation_time_us;
            });
        if (first == history_.end()) return std::nullopt;
        clear_resume();
        contiguous_emitted_end_us_.reset();
        const auto source_boundary = first->pts;
        const auto boundary_us = output_boundary_us.value_or(
            scaled(source_boundary, track_->timescale, 1000000));
        const auto output_boundary = scaled(boundary_us, 1000000, track_->timescale);
        const auto timestamp_shift = source_boundary - output_boundary;
        output_.audio_splice(boundary_us, timestamp_offset_us);
        source_buffer_timestamp_offset_us_ = timestamp_offset_us;
        BaseMuxer::activate();
        for (auto iterator = first; iterator != history_.end(); ++iterator) {
            auto sample = *iterator;
            sample.dts -= timestamp_shift;
            sample.pts -= timestamp_shift;
            enqueue(std::move(sample));
        }
        flush();
        return boundary_us;
    }

    std::optional<std::int64_t> activation_boundary_from(
        const std::int64_t earliest_presentation_time_us) const {
        if (!track_) return std::nullopt;
        const auto first = std::find_if(history_.begin(), history_.end(),
            [this, earliest_presentation_time_us](const Sample& sample) {
                return scaled(sample.pts, track_->timescale, 1000000) >=
                    earliest_presentation_time_us;
            });
        return first == history_.end()
            ? std::nullopt
            : std::optional<std::int64_t>{
                scaled(first->pts, track_->timescale, 1000000)};
    }

    std::optional<std::int64_t> contiguous_activation_boundary_from(
        const std::int64_t earliest_presentation_time_us,
        const std::int64_t minimum_duration_us) const {
        if (!track_) return std::nullopt;
        const auto first = std::find_if(history_.begin(), history_.end(),
            [this, earliest_presentation_time_us](const Sample& sample) {
                return scaled(sample.pts, track_->timescale, 1000000) >=
                    earliest_presentation_time_us;
            });
        if (first == history_.end()) return std::nullopt;
        auto start = first->pts;
        auto end = first->pts + static_cast<std::int64_t>(first->duration);
        const auto continuity_tolerance = scaled(
            kLayerSwitchContinuityToleranceUs, 1000000, track_->timescale);
        if (scaled(end - start, track_->timescale, 1000000) >= minimum_duration_us) {
            return scaled(start, track_->timescale, 1000000);
        }
        for (auto iterator = std::next(first); iterator != history_.end(); ++iterator) {
            if (iterator->pts > end + continuity_tolerance) {
                start = iterator->pts;
                end = iterator->pts + static_cast<std::int64_t>(iterator->duration);
            } else {
                end = std::max(end,
                    iterator->pts + static_cast<std::int64_t>(iterator->duration));
            }
            if (scaled(end - start, track_->timescale, 1000000) >= minimum_duration_us) {
                return scaled(start, track_->timescale, 1000000);
            }
        }
        return std::nullopt;
    }

    void push(const aribtlv::AccessUnit& unit, const bool selected,
              const bool output_enabled,
              const std::optional<std::int64_t> timeline_offset_us) {
        // Source packet loss is repaired below by compacting the next valid
        // AAC frame onto the contiguous decoder timeline. Resetting the sample
        // queue here used to discard every short prefix before a damaged AU,
        // leaving Chromium with ~0.1 s audio islands and DEMUXER_UNDERFLOW.
        const bool source_damage = unit.discontinuity &&
            aribtlv::hasDiscontinuityReason(
                unit.discontinuity_reasons,
                aribtlv::DiscontinuityReason::SourceDamage);
        if (unit.discontinuity && !source_damage) discontinuity(true);
        auto frame = parser_.parse(unit.data);
        if (max_channels_ != 0 && frame.channels > max_channels_) return;
        if (!track_) {
            set_track(audio_track(frame), selected);
            if (resume_at_ticks_.has_value()) {
                // Now that we know this track's timescale, convert the resume
                // point (given in the previous track's timescale) into ours.
                resume_offset_ticks_ = scaled(*resume_at_ticks_,
                    resume_timescale_, track_->timescale) -
                    scaled(source_buffer_timestamp_offset_us_, 1000000,
                           track_->timescale);
            }
        }
        if (!timeline_offset_us_.has_value()) {
            // Before any selected video configuration exists, keep AAC in its
            // broadcast timeline so a startup fallback can be prepared. Layer
            // activation later maps the chosen frame to the target video RAP.
            timeline_offset_us_ = timeline_offset_us.value_or(0);
        }
        std::int64_t timestamp =
            scaled(unit.pts.value, unit.pts.timescale, track_->timescale) +
            scaled(*timeline_offset_us_, 1000000, track_->timescale);
        if (resume_offset_ticks_.has_value()) {
            // First sample after a switch anchors to the resume point; later
            // samples advance by their native inter-frame delta so the
            // timeline does not drift relative to the source.
            if (!first_after_resume_) {
                resume_origin_ticks_ = timestamp;
                timestamp = *resume_offset_ticks_;
                first_after_resume_ = true;
            } else {
                timestamp = *resume_offset_ticks_ + (timestamp - *resume_origin_ticks_);
            }
        }
        if (timestamp < 0) return;
        if (track_configuration_differs(frame)) {
            // LATM can carry a new StreamMuxConfig on the same broadcast
            // audio track (this stream changes from 5.1 to stereo). The old
            // fMP4 init segment cannot describe the new raw AAC channel
            // elements, so close the old media timeline and emit a matching
            // init segment before accepting the new frame.
            const auto old_timescale = track_->timescale;
            const auto boundary_us = scaled(timestamp, old_timescale, 1000000);
            flush();
            const auto contiguous_output_end_us = contiguous_emitted_end_us_;
            const auto continuity_adjustment_us = contiguous_output_end_us.has_value()
                ? *contiguous_output_end_us -
                    source_buffer_timestamp_offset_us_ - boundary_us
                : 0;
            const auto timestamp_offset_us =
                source_buffer_timestamp_offset_us_ + continuity_adjustment_us;
            history_.clear();
            timestamp_correction_ticks_ = 0;
            if (selected) output_.audio_splice(boundary_us, timestamp_offset_us);
            source_buffer_timestamp_offset_us_ = timestamp_offset_us;
            replace_track(audio_track(frame), selected);
            timestamp = scaled(boundary_us, 1000000, track_->timescale);
        }
        if (!history_.empty() && timestamp <= history_.back().pts) {
            if (!unit.discontinuity) return;
            // A recoverable packet-loss marker keeps the current mapping when
            // PTS remains monotonic. A genuine backwards epoch starts a new
            // mapping from the selected video's current output timeline.
            if (!timeline_offset_us.has_value()) return;
            discontinuity(true);
            history_.clear();
            timeline_offset_us_ = *timeline_offset_us;
            timestamp =
                scaled(unit.pts.value, unit.pts.timescale, track_->timescale) +
                scaled(*timeline_offset_us_, 1000000, track_->timescale);
        }
        if (!history_.empty()) {
            // A lost AAC access unit leaves a forward hole in the source PTS.
            // BaseMuxer uses the next DTS as the previous trun sample's
            // duration, so passing that hole through would turn one 1024-tick
            // AAC frame into (for example) an 85 ms frame. Chromium may then
            // reject the first packet after the hole. Keep the AAC decode
            // timeline contiguous and carry the correction over subsequent
            // source timestamps.
            const auto frame_duration = static_cast<std::int64_t>(default_duration());
            const auto previous_timestamp = history_.back().pts;
            const auto candidate_timestamp = timestamp + timestamp_correction_ticks_;
            if (candidate_timestamp > previous_timestamp + frame_duration + 2) {
                timestamp_correction_ticks_ +=
                    previous_timestamp + frame_duration - candidate_timestamp;
            }
            timestamp += timestamp_correction_ticks_;
        }
        Sample sample{std::move(frame.data), timestamp, timestamp,
                      default_duration(), true};
        history_.push_back(sample);
        const auto history_ticks = scaled(
            kAudioHistoryDurationUs, 1000000, track_->timescale);
        while (!history_.empty() &&
               timestamp - history_.front().pts > history_ticks) {
            history_.pop_front();
        }
        if (!output_enabled) return;
        sample.duration = 0;
        enqueue(std::move(sample));
    }

private:
    static Mp4Track audio_track(const AacFrame& frame) {
        Mp4Track track;
        track.timescale = frame.sample_rate;
        track.sample_rate = frame.sample_rate;
        track.channels = frame.channels;
        track.codec = "mp4a.40." + std::to_string(frame.object);
        track.config = frame.asc;
        return track;
    }

    bool track_configuration_differs(const AacFrame& frame) const {
        if (!track_) return false;
        return track_->sample_rate != frame.sample_rate ||
            track_->channels != frame.channels ||
            track_->codec != "mp4a.40." + std::to_string(frame.object) ||
            track_->config != frame.asc;
    }

    std::uint32_t default_duration() const override {
        return track_ ? static_cast<std::uint32_t>(std::llround(
                            1024.0 * track_->timescale / track_->sample_rate))
                      : 21333;
    }

    void on_segment_emitted(const std::vector<Sample>& samples) override {
        if (samples.empty()) return;
        const auto start = scaled(
            samples.front().pts, track_->timescale, 1000000) +
            source_buffer_timestamp_offset_us_;
        auto end = scaled(
            samples.front().pts +
                static_cast<std::int64_t>(samples.front().duration),
            track_->timescale, 1000000) + source_buffer_timestamp_offset_us_;
        for (const auto& sample : samples) {
            end = std::max(
                end, scaled(sample.pts + static_cast<std::int64_t>(sample.duration),
                            track_->timescale, 1000000) +
                    source_buffer_timestamp_offset_us_);
        }
        if (!contiguous_emitted_end_us_.has_value()) {
            contiguous_emitted_end_us_ = end;
            return;
        }
        // Do not let a still-pending island after packet loss redefine the
        // handoff boundary. The replacement track must start at the end of
        // the old audio that a decoder can actually play continuously.
        if (start <= *contiguous_emitted_end_us_ + 2) {
            contiguous_emitted_end_us_ = std::max(*contiguous_emitted_end_us_, end);
        }
    }

    void clear_resume() noexcept {
        resume_at_ticks_.reset();
        resume_timescale_ = 0;
        resume_offset_ticks_.reset();
        resume_origin_ticks_.reset();
        first_after_resume_ = false;
        timestamp_correction_ticks_ = 0;
    }

    LatmParser parser_;
    Output& output_;
    std::uint32_t max_channels_ = 0;
    std::optional<std::int64_t> resume_at_ticks_;
    std::uint32_t resume_timescale_ = 0;
    std::optional<std::int64_t> resume_offset_ticks_;
    std::optional<std::int64_t> resume_origin_ticks_;
    bool first_after_resume_ = false;
    std::optional<std::int64_t> contiguous_emitted_end_us_;
    std::int64_t source_buffer_timestamp_offset_us_ = 0;
    std::int64_t timestamp_correction_ticks_ = 0;
    std::optional<std::int64_t> timeline_offset_us_;
    std::deque<Sample> history_;
};
