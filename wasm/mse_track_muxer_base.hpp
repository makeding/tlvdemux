constexpr std::uint32_t kFragmentDurationDivisor = 4;
// Firefox's MoofParser only bridges cross-moof composition gaps under 1us
// (dom/media/mp4/MoofParser.cpp), so a fragment can only be cut where the
// queue has a genuinely safe prefix. Bound how long we wait for one.
constexpr std::uint32_t kQueueDurationBoundMultiplier = 8;
constexpr std::int64_t kAudioHistoryDurationUs = 20000000;
constexpr std::int64_t kLayerSwitchVideoBufferUs = 400000;
constexpr std::int64_t kLayerSwitchAudioBufferUs = 2000000;
constexpr std::int64_t kLayerSwitchMaxAvGapUs = 500000;
constexpr std::int64_t kLayerSwitchMaxAudioFrameUs = 22000;
constexpr std::int64_t kLayerSwitchContinuityToleranceUs = 1000;

Bytes u32(const std::uint64_t value) {
    return {static_cast<std::uint8_t>(value >> 24U),
            static_cast<std::uint8_t>(value >> 16U),
            static_cast<std::uint8_t>(value >> 8U),
            static_cast<std::uint8_t>(value)};
}

class Output {
public:
    explicit Output(tlvdemux::MseSink& sink, const tlvdemux::MseOutputMode mode)
        : sink_(sink), mode_(mode) {}

    void set_enabled(const bool enabled) noexcept { enabled_ = enabled; }
    bool supports_video_reconfiguration() const noexcept {
        return mode_ == tlvdemux::MseOutputMode::SeparateTracks;
    }
    void begin_video_staging() {
        staged_video_events_.clear();
        stage_video_ = true;
    }
    void discard_staged_video() noexcept {
        stage_video_ = false;
        staged_video_events_.clear();
    }
    std::optional<std::pair<std::int64_t, std::int64_t>> staged_video_range() const {
        std::vector<std::pair<std::int64_t, std::int64_t>> ranges;
        for (const auto& event : staged_video_events_) {
            const auto* segment = std::get_if<tlvdemux::MseMediaSegment>(&event);
            if (segment && segment->type == "video") {
                ranges.emplace_back(segment->start_time_us, segment->end_time_us);
            }
        }
        if (ranges.empty()) return std::nullopt;
        std::sort(ranges.begin(), ranges.end());
        auto start = ranges.front().first;
        auto end = ranges.front().second;
        for (const auto& range : ranges) {
            if (range.first > end + kLayerSwitchContinuityToleranceUs) break;
            end = std::max(end, range.second);
        }
        return std::pair{start, end};
    }
    void set_staged_video_splice(const std::int64_t presentation_time_us,
                                 const std::int64_t timestamp_offset_us) {
        for (auto& event : staged_video_events_) {
            if (auto* splice = std::get_if<tlvdemux::MseVideoSplice>(&event)) {
                splice->presentation_time_us = presentation_time_us;
                splice->timestamp_offset_us = timestamp_offset_us;
            }
        }
    }
    void commit_staged_video() {
        stage_video_ = false;
        auto events = std::move(staged_video_events_);
        staged_video_events_.clear();
        for (auto& event : events) {
            std::visit([this](auto& value) {
                using Event = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<Event, tlvdemux::MseTrackInit>) {
                    sink_.onMseInit(std::move(value));
                } else if constexpr (std::is_same_v<Event, tlvdemux::MseMediaSegment>) {
                    sink_.onMseSegment(std::move(value));
                } else if constexpr (std::is_same_v<Event, tlvdemux::MseVideoSplice>) {
                    sink_.onMseVideoSplice(value);
                } else if constexpr (std::is_same_v<Event, tlvdemux::MseVideoProperties>) {
                    sink_.onMseVideoProperties(value);
                } else {
                    sink_.onMseVideoStart(value);
                }
            }, event);
        }
    }

    void init(const std::string& type, const Mp4Track& track) {
        if (!enabled_) return;
        if (mode_ == tlvdemux::MseOutputMode::Multiplexed) {
            tracks_[type] = track;
            emit_multiplexed_init();
            return;
        }
        tlvdemux::MseTrackInit event;
        event.type = type;
        event.mime = std::string(track.video ? "video/mp4; codecs=\"" :
                                               "audio/mp4; codecs=\"") +
            track.codec + "\"";
        event.data = init_segment(track);
        event.width = track.width;
        event.height = track.height;
        event.sample_rate = track.sample_rate;
        event.channels = track.channels;
        if (stage_video_ && type == "video") {
            staged_video_events_.push_back(std::move(event));
            return;
        }
        sink_.onMseInit(std::move(event));
    }

    void segment(const std::string& type, const Mp4Track& track,
                 const std::vector<Sample>& samples, const std::uint32_t sequence) {
        if (!enabled_) return;
        auto data = media_segment(track, samples,
            mode_ == tlvdemux::MseOutputMode::Multiplexed ? sequence_++ : sequence);
        auto start = samples.front().pts;
        auto end = samples.front().pts + static_cast<std::int64_t>(samples.front().duration);
        for (const auto& sample : samples) {
            start = std::min(start, sample.pts);
            end = std::max(end, sample.pts + static_cast<std::int64_t>(sample.duration));
        }
        const auto start_us = scaled(start, track.timescale, 1000000);
        const auto end_us = scaled(end, track.timescale, 1000000);
        if (mode_ == tlvdemux::MseOutputMode::SeparateTracks) {
            tlvdemux::MseMediaSegment event{type, std::move(data), start_us, end_us};
            if (stage_video_ && type == "video") {
                staged_video_events_.push_back(std::move(event));
                return;
            }
            sink_.onMseSegment(std::move(event));
            return;
        }
        if (!multiplexed_init_emitted_) {
            pending_segments_.push_back(std::move(data));
            return;
        }
        sink_.onMseSegment(
            tlvdemux::MseMediaSegment{"muxed", std::move(data), start_us, end_us});
    }

    void audio_splice(const std::int64_t presentation_time_us,
                      const std::int64_t timestamp_offset_us = 0) {
        if (!enabled_) return;
        sink_.onMseAudioSplice(tlvdemux::MseAudioSplice{
            presentation_time_us, timestamp_offset_us});
    }

    void video_splice(const std::int64_t presentation_time_us,
                      const std::int64_t timestamp_offset_us = 0) {
        if (!enabled_) return;
        const tlvdemux::MseVideoSplice event{
            presentation_time_us, timestamp_offset_us};
        if (stage_video_) {
            staged_video_events_.push_back(event);
            return;
        }
        sink_.onMseVideoSplice(event);
    }

    void layer_switch(const std::uint64_t video_track_id,
                      const std::uint64_t audio_track_id,
                      const std::int64_t video_presentation_time_us,
                      const std::int64_t audio_presentation_time_us) {
        if (!enabled_) return;
        sink_.onMseLayerSwitch(tlvdemux::MseLayerSwitch{
            video_track_id, audio_track_id,
            video_presentation_time_us, audio_presentation_time_us});
    }

    void video_start(const int nal_type, const bool signalled) {
        if (!enabled_) return;
        const tlvdemux::MseVideoStart event{nal_type, signalled};
        if (stage_video_) {
            staged_video_events_.push_back(event);
            return;
        }
        sink_.onMseVideoStart(event);
    }

    void video_recovery(const tlvdemux::MseVideoRecoveryEvent& event) {
        if (!enabled_) return;
        sink_.onMseVideoRecovery(event);
    }

    void video_properties(const tlvdemux::MseVideoProperties& properties) {
        if (stage_video_) {
            staged_video_events_.push_back(properties);
            return;
        }
        sink_.onMseVideoProperties(properties);
    }

private:
    void emit_multiplexed_init() {
        if (multiplexed_init_emitted_ || tracks_.count("video") == 0 ||
            tracks_.count("audio") == 0) return;
        const std::vector<Mp4Track> tracks{tracks_.at("video"), tracks_.at("audio")};
        tlvdemux::MseTrackInit event;
        event.type = "muxed";
        event.mime = "video/mp4";
        event.data = init_segment(tracks);
        event.width = tracks.front().width;
        event.height = tracks.front().height;
        event.sample_rate = tracks.back().sample_rate;
        event.channels = tracks.back().channels;
        sink_.onMseInit(std::move(event));
        multiplexed_init_emitted_ = true;
        for (auto& data : pending_segments_) {
            sink_.onMseSegment(tlvdemux::MseMediaSegment{"muxed", std::move(data), 0, 0});
        }
        pending_segments_.clear();
    }

    tlvdemux::MseSink& sink_;
    tlvdemux::MseOutputMode mode_;
    std::map<std::string, Mp4Track> tracks_;
    std::vector<Bytes> pending_segments_;
    std::uint32_t sequence_ = 1;
    bool multiplexed_init_emitted_ = false;
    bool enabled_ = true;
    using StagedVideoEvent = std::variant<
        tlvdemux::MseVideoSplice, tlvdemux::MseTrackInit,
        tlvdemux::MseVideoStart, tlvdemux::MseVideoProperties,
        tlvdemux::MseMediaSegment>;
    std::vector<StagedVideoEvent> staged_video_events_;
    bool stage_video_ = false;
};

class BaseMuxer {
public:
    BaseMuxer(std::string type, const std::uint32_t track_id, Output& output)
        : type_(std::move(type)), track_id_(track_id), output_(output) {}
    virtual ~BaseMuxer() = default;

    void reset_samples() {
        pending_.reset();
        ready_.clear();
        ready_duration_ = 0;
        last_duration_ = 0;
    }

    void activate() {
        reset_samples();
        emit_init();
    }

    void discard() { reset_samples(); }

    void flush() {
        if (pending_) {
            pending_->duration = last_duration_ != 0 ? last_duration_ : default_duration();
            ready_.push_back(std::move(*pending_));
            pending_.reset();
        }
        emit(true);
    }

protected:
    virtual std::uint32_t default_duration() const = 0;
    virtual void on_segment_emitted(const std::vector<Sample>&) {}

    void set_track(Mp4Track track, const bool emit = true) {
        if (track_) return;
        track.id = track_id_;
        track_ = std::move(track);
        if (emit) emit_init();
    }

    void replace_track(Mp4Track track, const bool emit = true) {
        track.id = track_id_;
        track_ = std::move(track);
        if (emit) emit_init();
    }

    void flush_at(const std::int64_t next_dts) {
        if (pending_) {
            const auto delta = next_dts - pending_->dts;
            pending_->duration = delta > 0
                ? static_cast<std::uint32_t>(delta)
                : (last_duration_ != 0 ? last_duration_ : default_duration());
            last_duration_ = pending_->duration;
            ready_duration_ += pending_->duration;
            ready_.push_back(std::move(*pending_));
            pending_.reset();
        }
        emit(true);
    }

    void emit_init() {
        if (track_) output_.init(type_, *track_);
    }

    bool enqueue(Sample sample) {
        if (pending_) {
            // A trun sample duration is the delta to the next decode timestamp;
            // a non-advancing DTS has no representable duration, so drop it
            // rather than fabricate one (see Firefox CtsComparator background).
            const auto delta = sample.dts - pending_->dts;
            if (delta <= 0) return false;
            pending_->duration = static_cast<std::uint32_t>(delta);
            last_duration_ = pending_->duration;
            ready_duration_ += pending_->duration;
            ready_.push_back(std::move(*pending_));
        }
        pending_ = std::move(sample);
        if (!track_) return true;
        const auto threshold = std::max<std::uint32_t>(1, track_->timescale / kFragmentDurationDivisor);
        if (ready_duration_ >= threshold) emit(false);
        if (ready_duration_ >= std::uint64_t(threshold) * kQueueDurationBoundMultiplier) emit(true);
        return true;
    }

    // Longest prefix of ready_ whose composition interval cannot overlap
    // anything still queued after it (rest of ready_, plus pending_). Cutting
    // a fragment there is safe: Firefox's CtsComparator reorders each moof's
    // samples by composition time, so a cut mid reorder-group would make this
    // fragment's interval overlap the next one and evict already-buffered frames.
    std::size_t safe_prefix() const {
        const auto count = ready_.size();
        if (count == 0) return 0;
        std::vector<std::int64_t> min_from(count + 1);
        min_from[count] = pending_ ? pending_->pts : std::numeric_limits<std::int64_t>::max();
        for (std::size_t index = count; index-- > 0;) {
            min_from[index] = std::min(ready_[index].pts, min_from[index + 1]);
        }
        std::size_t safe = 0;
        std::int64_t prefix_end = std::numeric_limits<std::int64_t>::min();
        for (std::size_t index = 0; index < count; ++index) {
            prefix_end = std::max(prefix_end,
                                  ready_[index].pts + static_cast<std::int64_t>(ready_[index].duration));
            if (prefix_end <= min_from[index + 1]) safe = index + 1;
        }
        return safe;
    }

    void emit(const bool force) {
        if (!track_ || ready_.empty()) return;
        const auto count = force ? ready_.size() : safe_prefix();
        if (count == 0) return;
        std::uint64_t emitted_duration = 0;
        for (std::size_t index = 0; index < count; ++index) {
            emitted_duration += ready_[index].duration;
        }
        std::vector<Sample> segment;
        segment.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            segment.push_back(std::move(ready_[index]));
        }
        output_.segment(type_, *track_, segment, sequence_++);
        on_segment_emitted(segment);
        ready_.erase(ready_.begin(), ready_.begin() + static_cast<std::ptrdiff_t>(count));
        ready_duration_ -= emitted_duration;
    }

    std::optional<Mp4Track> track_;

private:
    std::string type_;
    std::uint32_t track_id_;
    Output& output_;
    std::optional<Sample> pending_;
    std::vector<Sample> ready_;
    std::uint64_t ready_duration_ = 0;
    std::uint32_t sequence_ = 1;
    std::uint32_t last_duration_ = 0;
};
