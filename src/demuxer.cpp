#include <tlvdemux/demuxer.hpp>

#include <array>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>

#include "compressed_ip_parser.hpp"

namespace tlvdemux {

class Demuxer::Impl {
public:
    Impl(Sink& sink, Limits limits)
        : sink_(sink), limits_(std::move(limits)),
          ip_(limits_,
              [this](ServiceInfo info) { service(std::move(info)); },
              [this](TrackInfo info) { return track(std::move(info)); },
              [this](detail::TimedAccessUnit unit) { access_unit(std::move(unit)); },
              [this](const ErrorCode code, const std::uint64_t offset,
                     const bool recoverable, std::string message) {
                  error(code, offset, recoverable, std::move(message));
              }),
          tlv_(limits_,
               [this](const detail::TlvPacketView& packet) { ip_.consume(packet); },
               [this](const ErrorCode code, const std::uint64_t offset,
                      const bool recoverable, std::string message) {
                   error(code, offset, recoverable, std::move(message));
               }) {}

    void push(const std::uint8_t* data, const std::size_t size) {
        if (data == nullptr && size != 0) {
            error(ErrorCode::MalformedInput, 0, false,
                  "Demuxer::push received a null pointer with non-zero size");
            return;
        }
        tlv_.push(data, size);
    }

    void flush() {
        tlv_.flush();
        ip_.flush();
    }

    void reset() {
        tlv_.reset();
        ip_.reset();
        services_.clear();
        current_tracks_.clear();
        error_counts_.clear();
        origin_.reset();
    }

    void select_service(std::optional<std::uint32_t> context_id) {
        selected_service_ = context_id;
        ip_.select_service(context_id);
        services_.clear();
        current_tracks_.clear();
        origin_.reset();
    }

    void select_track(const TrackKind kind, std::optional<std::uint64_t> track_id) {
        selected_tracks_[static_cast<std::size_t>(kind)] = track_id;
        ip_.reset();
        current_tracks_.clear();
        origin_.reset();
    }

private:
    static bool same_track(const TrackInfo& left, const TrackInfo& right) {
        const auto same_audio = [](const std::optional<AudioInfo>& first,
                                   const std::optional<AudioInfo>& second) {
            if (first.has_value() != second.has_value()) return false;
            if (!first.has_value()) return true;
            return first->component_type == second->component_type &&
                   first->channel_layout == second->channel_layout &&
                   first->stream_type == second->stream_type &&
                   first->simulcast_group_tag == second->simulcast_group_tag &&
                   first->es_multi_lingual == second->es_multi_lingual &&
                   first->main_component == second->main_component &&
                   first->quality_indicator == second->quality_indicator &&
                   first->sampling_rate_code == second->sampling_rate_code &&
                   first->sample_rate == second->sample_rate &&
                   first->secondary_language == second->secondary_language;
        };
        return left.track_id == right.track_id && left.context_id == right.context_id &&
               left.packet_id == right.packet_id && left.asset_id == right.asset_id &&
               left.kind == right.kind && left.codec == right.codec &&
               left.language == right.language && left.component_tag == right.component_tag &&
               left.timescale == right.timescale && same_audio(left.audio, right.audio);
    }

    void service(ServiceInfo info) {
        if (selected_service_.has_value() && *selected_service_ != info.context_id) {
            return;
        }
        const auto found = services_.find(info.context_id);
        if (found != services_.end() && found->second == info.package_id) {
            return;
        }
        services_[info.context_id] = info.package_id;
        sink_.onService(info);
    }

    std::uint64_t track(TrackInfo info) {
        if (selected_service_.has_value() && *selected_service_ != info.context_id) {
            return 0;
        }
        std::string identity;
        identity.reserve(6 + info.asset_id.size());
        for (const auto shift : {24U, 16U, 8U, 0U}) {
            identity.push_back(static_cast<char>((info.context_id >> shift) & 0xffU));
        }
        identity.push_back(static_cast<char>(info.packet_id >> 8U));
        identity.push_back(static_cast<char>(info.packet_id & 0xffU));
        identity.append(reinterpret_cast<const char*>(info.asset_id.data()), info.asset_id.size());

        auto id = track_ids_.find(identity);
        if (id == track_ids_.end()) {
            id = track_ids_.emplace(std::move(identity), next_track_id_++).first;
        }
        info.track_id = id->second;
        const auto current = current_tracks_.find(info.track_id);
        if (current != current_tracks_.end() && same_track(current->second, info)) {
            return info.track_id;
        }
        current_tracks_[info.track_id] = info;
        sink_.onTrack(info);
        return info.track_id;
    }

    static bool ntp_delta_ticks(const std::uint64_t current, const std::uint64_t origin,
                                const std::uint32_t timescale, std::int64_t& output) {
        const bool negative = current < origin;
        const auto difference = negative ? origin - current : current - origin;
        const auto seconds = difference >> 32U;
        const auto fraction = static_cast<std::uint32_t>(difference);
        if (timescale != 0 && seconds >
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) / timescale) {
            return false;
        }
        const auto whole_ticks = seconds * timescale;
        const auto fractional_ticks =
            (static_cast<std::uint64_t>(fraction) * timescale) >> 32U;
        if (whole_ticks > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) -
                              fractional_ticks) {
            return false;
        }
        const auto magnitude = static_cast<std::int64_t>(whole_ticks + fractional_ticks);
        output = negative ? -magnitude : magnitude;
        return true;
    }

    static bool rescale_offset(const std::int64_t value, const std::uint32_t source_scale,
                               const std::uint32_t target_scale, std::int64_t& output) {
        if (source_scale == 0) return false;
        const bool negative = value < 0;
        const auto magnitude = negative
            ? static_cast<std::uint64_t>(-(value + 1)) + 1U
            : static_cast<std::uint64_t>(value);
        const auto whole = magnitude / source_scale;
        const auto remainder = magnitude % source_scale;
        if (target_scale != 0 && whole >
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) / target_scale) {
            return false;
        }
        const auto scaled = whole * target_scale + remainder * target_scale / source_scale;
        if (scaled > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            return false;
        }
        output = negative ? -static_cast<std::int64_t>(scaled) : static_cast<std::int64_t>(scaled);
        return true;
    }

    static bool add_checked(const std::int64_t left, const std::int64_t right,
                            std::int64_t& output) {
        if ((right > 0 && left > std::numeric_limits<std::int64_t>::max() - right) ||
            (right < 0 && left < std::numeric_limits<std::int64_t>::min() - right)) {
            return false;
        }
        output = left + right;
        return true;
    }

    static bool subtract_checked(const std::int64_t left, const std::int64_t right,
                                 std::int64_t& output) {
        if ((right > 0 && left < std::numeric_limits<std::int64_t>::min() + right) ||
            (right < 0 && left > std::numeric_limits<std::int64_t>::max() + right)) {
            return false;
        }
        output = left - right;
        return true;
    }

    void access_unit(detail::TimedAccessUnit timed) {
        auto& unit = timed.unit;
        const auto track_info = current_tracks_.find(unit.track_id);
        if (unit.track_id == 0 || track_info == current_tracks_.end()) return;
        const auto kind_index = static_cast<std::size_t>(track_info->second.kind);
        if (selected_tracks_[kind_index].has_value() &&
            *selected_tracks_[kind_index] != unit.track_id) {
            return;
        }
        if (unit.pts.timescale == 0 || unit.dts.timescale != unit.pts.timescale) {
            error(ErrorCode::MalformedInput, unit.input_offset, true,
                  "access unit has an invalid or inconsistent timescale");
            return;
        }
        if (!origin_.has_value()) {
            origin_ = TimelineOrigin{timed.source_ntp_raw, unit.pts.value, unit.pts.timescale};
        }

        std::int64_t ntp_ticks = 0;
        std::int64_t origin_offset = 0;
        if (!ntp_delta_ticks(timed.source_ntp_raw, origin_->ntp, unit.pts.timescale, ntp_ticks) ||
            !rescale_offset(origin_->pts_offset, origin_->timescale,
                            unit.pts.timescale, origin_offset)) {
            error(ErrorCode::Discontinuity, unit.input_offset, true,
                  "timestamp normalization overflowed");
            return;
        }
        std::int64_t normalized_pts = 0;
        std::int64_t normalized_dts = 0;
        std::int64_t base = 0;
        if (!subtract_checked(ntp_ticks, origin_offset, base) ||
            !add_checked(base, unit.pts.value, normalized_pts) ||
            !add_checked(base, unit.dts.value, normalized_dts)) {
            error(ErrorCode::Discontinuity, unit.input_offset, true,
                  "normalized access-unit timestamp is out of range");
            return;
        }
        unit.pts.value = normalized_pts;
        unit.dts.value = normalized_dts;
        sink_.onAccessUnit(std::move(unit));
    }

    void error(const ErrorCode code, const std::uint64_t offset, const bool recoverable,
               std::string message) {
        const auto key = std::to_string(static_cast<int>(code)) + ':' + message;
        auto& count = error_counts_[key];
        ++count;
        const bool power_of_two = (count & (count - 1U)) == 0;
        if (power_of_two) {
            sink_.onError(Error{code, offset, recoverable, std::move(message)});
        }
    }

    Sink& sink_;
    Limits limits_;
    detail::CompressedIpParser ip_;
    detail::TlvParser tlv_;
    std::optional<std::uint32_t> selected_service_;
    std::array<std::optional<std::uint64_t>, 3> selected_tracks_{};
    std::unordered_map<std::uint32_t, std::vector<std::uint8_t>> services_;
    std::unordered_map<std::string, std::uint64_t> track_ids_;
    std::unordered_map<std::uint64_t, TrackInfo> current_tracks_;
    std::uint64_t next_track_id_ = 1;
    std::unordered_map<std::string, std::uint64_t> error_counts_;
    struct TimelineOrigin {
        std::uint64_t ntp = 0;
        std::int64_t pts_offset = 0;
        std::uint32_t timescale = 1;
    };
    std::optional<TimelineOrigin> origin_;
};

Demuxer::Demuxer(Sink& sink) : Demuxer(sink, Limits{}) {}

Demuxer::Demuxer(Sink& sink, Limits limits)
    : impl_(std::make_unique<Impl>(sink, std::move(limits))) {}

Demuxer::~Demuxer() = default;
Demuxer::Demuxer(Demuxer&&) noexcept = default;
Demuxer& Demuxer::operator=(Demuxer&&) noexcept = default;

void Demuxer::push(const std::uint8_t* data, const std::size_t size) {
    impl_->push(data, size);
}

void Demuxer::flush() {
    impl_->flush();
}

void Demuxer::reset() {
    impl_->reset();
}

void Demuxer::selectService(std::optional<std::uint32_t> context_id) {
    impl_->select_service(context_id);
}

void Demuxer::selectTrack(const TrackKind kind, std::optional<std::uint64_t> track_id) {
    impl_->select_track(kind, track_id);
}

} // namespace tlvdemux
