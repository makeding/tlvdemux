#include <tlvdemux/mse_remuxer.hpp>

#include "mse/hevc_parser.hpp"
#include "mse/latm_parser.hpp"
#include "mse/mp4_builder.hpp"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>
namespace {

using tlvdemux::detail::mse::AacFrame;
using tlvdemux::detail::mse::Bytes;
using tlvdemux::detail::mse::HevcConfiguration;
using tlvdemux::detail::mse::LatmParser;
using tlvdemux::detail::mse::Mp4Track;
using tlvdemux::detail::mse::NaluView;
using tlvdemux::detail::mse::Sample;
using tlvdemux::detail::mse::annex_b_views;
using tlvdemux::detail::mse::append;
using tlvdemux::detail::mse::copy_nalu;
using tlvdemux::detail::mse::hevc_configuration;
using tlvdemux::detail::mse::init_segment;
using tlvdemux::detail::mse::media_segment;
using tlvdemux::detail::mse::scaled;

constexpr std::uint32_t kFragmentDurationDivisor = 4;
// Firefox's MoofParser only bridges cross-moof composition gaps under 1us
// (dom/media/mp4/MoofParser.cpp), so a fragment can only be cut where the
// queue has a genuinely safe prefix. Bound how long we wait for one.
constexpr std::uint32_t kQueueDurationBoundMultiplier = 8;
constexpr std::int64_t kAudioHistoryDurationUs = 20000000;
constexpr std::int64_t kLayerSwitchAudioBufferUs = 400000;

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

    void audio_splice(const std::int64_t presentation_time_us) {
        if (!enabled_) return;
        sink_.onMseAudioSplice(tlvdemux::MseAudioSplice{presentation_time_us});
    }

    void video_splice(const std::int64_t presentation_time_us) {
        if (!enabled_) return;
        const tlvdemux::MseVideoSplice event{presentation_time_us};
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
        tlvdemux::MseVideoStart, tlvdemux::MseMediaSegment>;
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

    void set_track(Mp4Track track, const bool emit = true) {
        if (track_) return;
        track.id = track_id_;
        track_ = std::move(track);
        if (emit) emit_init();
    }

    void replace_track(Mp4Track track) {
        track.id = track_id_;
        track_ = std::move(track);
        emit_init();
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

class HevcMuxer final : public BaseMuxer {
public:
    explicit HevcMuxer(Output& output) : BaseMuxer("video", 1, output), output_(output) {}

    bool started() const noexcept { return started_; }
    bool is_input_track_switch(const aribtlv::AccessUnit& unit) const noexcept {
        return unit.discontinuity && input_track_id_.has_value() &&
            *input_track_id_ != unit.track_id;
    }
    std::optional<std::int64_t> take_splice_boundary_us() noexcept {
        return std::exchange(splice_boundary_us_, std::nullopt);
    }
    void stage_next_switch() noexcept { stage_next_switch_ = true; }
    void cancel_staged_switch() noexcept { stage_next_switch_ = false; }
    // AacMuxer has its own (sample-rate) track timescale, so it needs this
    // shared offset in microseconds regardless of the video track timescale.
    std::optional<std::int64_t> timeline_offset_us() const noexcept {
        if (!timeline_offset_ticks_) return std::nullopt;
        return scaled(*timeline_offset_ticks_, track_->timescale, 1000000);
    }

    void reset() {
        reset_samples();
        parameter_sets_.clear();
        track_.reset();
        started_ = false;
        no_rasl_output_ = false;
        sequence_start_ = true;
        timeline_offset_ticks_.reset();
        input_track_id_.reset();
        splice_boundary_us_.reset();
        stage_next_switch_ = false;
    }

    void push(const aribtlv::AccessUnit& unit, const bool output_enabled) {
        splice_boundary_us_.reset();
        const auto nalus = annex_b_views(unit.data);
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
        const bool track_switch_boundary = unit.discontinuity && input_track_id_.has_value() &&
            *input_track_id_ != unit.track_id && irap >= 0;
        bool configuration_boundary = false;
        if (parameter_sets_.count(32) != 0 && parameter_sets_.count(33) != 0 &&
            parameter_sets_.count(34) != 0) {
            const auto config = hevc_configuration(
                parameter_sets_[32], parameter_sets_[33], parameter_sets_[34]);
            auto candidate = video_track(config, unit);
            if (!track_) {
                set_track(std::move(candidate));
            } else if (has_parameter_set && irap >= 0 && configuration_differs(candidate)) {
                if (output_enabled && !output_.supports_video_reconfiguration()) {
                    throw std::runtime_error(
                        "HEVC configuration changes require SeparateTracks MSE output");
                }
                const auto offset = timeline_offset_ticks_.value_or(0);
                const auto boundary_dts = scaled(unit.dts.value, unit.dts.timescale,
                                                 track_->timescale) + offset;
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
                started_ = false;
                no_rasl_output_ = false;
                sequence_start_ = true;
                configuration_boundary = true;
            }
        }
        if (track_switch_boundary && !configuration_boundary) {
            const auto offset = timeline_offset_ticks_.value_or(0);
            const auto boundary_dts = scaled(unit.dts.value, unit.dts.timescale,
                                             track_->timescale) + offset;
            const auto boundary_pts = scaled(unit.pts.value, unit.pts.timescale,
                                             track_->timescale) + offset;
            flush_at(boundary_dts);
            if (stage_next_switch_) {
                output_.begin_video_staging();
                stage_next_switch_ = false;
            }
            splice_boundary_us_ = scaled(boundary_pts, track_->timescale, 1000000);
            output_.video_splice(*splice_boundary_us_);
            started_ = false;
            no_rasl_output_ = false;
            sequence_start_ = true;
            configuration_boundary = true;
        }
        if (unit.discontinuity && !configuration_boundary) {
            // A timeline discontinuity normally discards incomplete old media.
            // When this AU also carries a new RAP configuration, the branch
            // above has already sealed and emitted the old configuration at
            // this RAP boundary instead.
            reset_samples();
            started_ = false;
            no_rasl_output_ = false;
            sequence_start_ = true;
            timeline_offset_ticks_.reset();
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
        if (!output_enabled) return;

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
        enqueue({std::move(data), dts, pts, 0, irap >= 0});
    }

private:
    static Mp4Track video_track(const HevcConfiguration& config,
                                const aribtlv::AccessUnit& unit) {
        Mp4Track track;
        track.video = true;
        track.width = config.width;
        track.height = config.height;
        track.codec = config.codec;
        track.config = config.hvcc;
        track.color = config.color;
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
            track_->color != candidate.color;
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
    bool started_ = false;
    bool no_rasl_output_ = false;
    bool sequence_start_ = true;
    std::optional<std::int64_t> timeline_offset_ticks_;
    std::optional<std::uint64_t> input_track_id_;
    std::optional<std::int64_t> splice_boundary_us_;
    bool stage_next_switch_ = false;
};

class AacMuxer final : public BaseMuxer {
public:
    explicit AacMuxer(Output& output, const std::uint32_t max_channels)
        : BaseMuxer("audio", 2, output), output_(output),
          max_channels_(max_channels) {}

    void discontinuity() {
        reset_samples();
        clear_resume();
        history_.clear();
    }

    void activate() {
        clear_resume();
        BaseMuxer::activate();
    }

    // Continue this muxer's decode timeline at the exact end of the previous
    // audio track. This is set before the first access unit of a new track and
    // reset on every later activation, including switches back to a used track.
    void resume_at(const std::int64_t resume_at_ticks,
                   const std::uint32_t resume_timescale) {
        resume_at_ticks_ = resume_at_ticks;
        resume_timescale_ = resume_timescale;
        resume_offset_ticks_ = track_.has_value()
            ? std::optional<std::int64_t>(scaled(resume_at_ticks,
                                                resume_timescale, track_->timescale))
            : std::nullopt;
        resume_origin_ticks_.reset();
        first_after_resume_ = false;
    }

    std::optional<std::int64_t> timeline_end() const noexcept {
        if (!last_enqueued_dts_.has_value() || !track_.has_value()) return std::nullopt;
        return *last_enqueued_dts_ + static_cast<std::int64_t>(default_duration());
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
        const std::int64_t earliest_presentation_time_us) {
        if (!track_) return std::nullopt;
        const auto first = std::find_if(history_.begin(), history_.end(),
            [this, earliest_presentation_time_us](const Sample& sample) {
                return scaled(sample.pts, track_->timescale, 1000000) >=
                    earliest_presentation_time_us;
            });
        if (first == history_.end()) return std::nullopt;
        clear_resume();
        const auto boundary_us = scaled(first->pts, track_->timescale, 1000000);
        output_.audio_splice(boundary_us);
        BaseMuxer::activate();
        for (auto iterator = first; iterator != history_.end(); ++iterator) {
            auto sample = *iterator;
            if (enqueue(std::move(sample))) last_enqueued_dts_ = iterator->dts;
        }
        flush();
        return boundary_us;
    }

    bool has_contiguous_history_from(
        const std::int64_t earliest_presentation_time_us,
        const std::int64_t minimum_duration_us) const {
        if (!track_) return false;
        const auto first = std::find_if(history_.begin(), history_.end(),
            [this, earliest_presentation_time_us](const Sample& sample) {
                return scaled(sample.pts, track_->timescale, 1000000) >=
                    earliest_presentation_time_us;
            });
        if (first == history_.end()) return false;
        const auto start = first->pts;
        auto end = first->pts + static_cast<std::int64_t>(first->duration);
        if (scaled(end - start, track_->timescale, 1000000) >= minimum_duration_us) {
            return true;
        }
        for (auto iterator = std::next(first); iterator != history_.end(); ++iterator) {
            if (iterator->pts > end) return false;
            end = std::max(end,
                iterator->pts + static_cast<std::int64_t>(iterator->duration));
            if (scaled(end - start, track_->timescale, 1000000) >= minimum_duration_us) {
                return true;
            }
        }
        return false;
    }

    void push(const aribtlv::AccessUnit& unit, const bool selected,
              const bool output_enabled,
              const std::optional<std::int64_t> timeline_offset_us) {
        if (unit.discontinuity) discontinuity();
        auto frame = parser_.parse(unit.data);
        if (max_channels_ != 0 && frame.channels > max_channels_) return;
        if (!track_) {
            Mp4Track track;
            track.timescale = frame.sample_rate;
            track.sample_rate = frame.sample_rate;
            track.channels = frame.channels;
            track.codec = "mp4a.40." + std::to_string(frame.object);
            track.config = frame.asc;
            set_track(std::move(track), selected);
            if (resume_at_ticks_.has_value()) {
                // Now that we know this track's timescale, convert the resume
                // point (given in the previous track's timescale) into ours.
                resume_offset_ticks_ = scaled(*resume_at_ticks_,
                    resume_timescale_, track_->timescale);
            }
        }
        if (!timeline_offset_us.has_value()) return;
        std::int64_t timestamp =
            scaled(unit.pts.value, unit.pts.timescale, track_->timescale) +
            scaled(*timeline_offset_us, 1000000, track_->timescale);
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
        if (!history_.empty() && timestamp <= history_.back().pts) return;
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
        if (enqueue(std::move(sample))) {
            last_enqueued_dts_ = timestamp;
        }
    }

private:
    std::uint32_t default_duration() const override {
        return track_ ? static_cast<std::uint32_t>(std::llround(
                            1024.0 * track_->timescale / track_->sample_rate))
                      : 21333;
    }

    void clear_resume() noexcept {
        resume_at_ticks_.reset();
        resume_timescale_ = 0;
        resume_offset_ticks_.reset();
        resume_origin_ticks_.reset();
        first_after_resume_ = false;
        last_enqueued_dts_.reset();
    }

    LatmParser parser_;
    Output& output_;
    std::uint32_t max_channels_ = 0;
    std::optional<std::int64_t> resume_at_ticks_;
    std::uint32_t resume_timescale_ = 0;
    std::optional<std::int64_t> resume_offset_ticks_;
    std::optional<std::int64_t> resume_origin_ticks_;
    bool first_after_resume_ = false;
    std::optional<std::int64_t> last_enqueued_dts_;
    std::deque<Sample> history_;
};

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
            video_id = id;
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
        const std::uint64_t id, const std::int64_t earliest_presentation_time_us) {
        if (pending_layer) return std::nullopt;
        if (audio_id == id && active_audio != nullptr) return std::nullopt;
        const auto candidate = audio.find(id);
        if (candidate == audio.end()) return std::nullopt;
        const auto boundary = candidate->second.activate_from(
            earliest_presentation_time_us);
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
        video_id = target_video_id;
        return true;
    }

    void complete_layer_switch() {
        if (!pending_layer || !pending_layer->video_boundary_us) return;
        if (audio_id == pending_layer->audio_track_id && active_audio != nullptr) {
            video.flush();
            output.commit_staged_video();
            output.layer_switch(
                pending_layer->video_track_id, pending_layer->audio_track_id,
                *pending_layer->video_boundary_us, *pending_layer->video_boundary_us);
            pending_layer.reset();
            return;
        }
        const auto candidate = audio.find(pending_layer->audio_track_id);
        const auto earliest_audio = std::max(
            pending_layer->earliest_presentation_time_us,
            *pending_layer->video_boundary_us);
        if (candidate == audio.end() ||
            !candidate->second.has_contiguous_history_from(
                earliest_audio, kLayerSwitchAudioBufferUs)) return;
        const auto completed = *pending_layer;
        pending_layer.reset();
        video.flush();
        output.commit_staged_video();
        const auto boundary = switch_audio(
            completed.audio_track_id, earliest_audio);
        if (!boundary) return;
        output.layer_switch(
            completed.video_track_id, completed.audio_track_id,
            *completed.video_boundary_us, *boundary);
    }

    void push(const aribtlv::AccessUnit& unit) {
        if (video_id && unit.track_id == *video_id) {
            if (unit.discontinuity && !video.is_input_track_switch(unit)) {
                for (auto& entry : audio) entry.second.discontinuity();
            }
            video.push(unit, enabled);
            if (pending_layer && unit.track_id == pending_layer->video_track_id) {
                const auto boundary = video.take_splice_boundary_us();
                if (boundary) pending_layer->video_boundary_us = boundary;
                complete_layer_switch();
            }
            return;
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
        video.reset();
        audio.clear();
        active_audio = nullptr;
        output.discard_staged_video();
        return cancelled;
    }

    std::optional<MseLayerSwitchCancelled> reposition() {
        auto cancelled = cancel_layer(MseLayerSwitchCancelReason::Reposition);
        video.reset();
        for (auto& entry : audio) entry.second.discontinuity();
        output.discard_staged_video();
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

void tlvdemux::MseRemuxer::setOutputEnabled(const bool enabled) {
    const bool was_enabled = impl_->enabled;
    impl_->enabled = enabled;
    impl_->output.set_enabled(enabled);
    if (enabled && !was_enabled && impl_->active_audio) {
        impl_->active_audio->activate();
    }
}

void tlvdemux::MseRemuxer::push(const AccessUnit& unit) { impl_->push(unit); }
void tlvdemux::MseRemuxer::flush() { impl_->flush(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::endOfStream() { return impl_->end_of_stream(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reset() { return impl_->reset(); }
std::optional<tlvdemux::MseLayerSwitchCancelled>
tlvdemux::MseRemuxer::reposition() { return impl_->reposition(); }
