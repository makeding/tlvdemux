#include <aribtlv/application_resources.hpp>
#include <aribtlv/demuxer.hpp>
#include <aribtlv/duration_probe.hpp>
#include <aribtlv/recording.hpp>
#include <aribtlv/video_presentation.hpp>
#include <aribtlv/video_color.hpp>

#include <tlvdemux/hlg_sdr_tone_mapping.hpp>

#include "mse_remuxer.hpp"
#include "mse/presentation_policy.hpp"

#include <cmath>
#include <cstddef>
#include <array>
#include <cstdint>
#include <deque>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <emscripten/val.h>

namespace {

using emscripten::val;
using tlvdemux::detail::mse::PresentationPolicy;

val copy_bytes(const std::vector<std::uint8_t>& source) {
    auto result = val::global("Uint8Array").new_(source.size());
    if (!source.empty()) {
        result.call<void>("set", val(emscripten::typed_memory_view(source.size(), source.data())));
    }
    return result;
}

template <std::size_t Size>
val copy_bytes(const std::array<std::uint8_t, Size>& source) {
    auto result = val::global("Uint8Array").new_(source.size());
    result.template call<void>(
        "set", val(emscripten::typed_memory_view(source.size(), source.data())));
    return result;
}

val hlg_sdr_tone_mapping_lut_value() {
    const auto lut = tlvdemux::hlg_sdr_tone_mapping_lut();
    auto result = val::global("Uint8Array").new_(lut.size());
    result.call<void>("set", val(emscripten::typed_memory_view(lut.size(), lut.data())));
    return result;
}

val hlg_sdr_color_lut_value() {
    const auto lut = tlvdemux::hlg_sdr_color_lut();
    auto result = val::object();
    result.set("size", lut.size);
    result.set("width", lut.width);
    result.set("height", lut.height);
    result.set("data", copy_bytes(lut.rgba));
    return result;
}

val hlg_sdr_prototype_color_lut_value() {
    const auto lut = tlvdemux::hlg_sdr_prototype_color_lut();
    auto result = val::object();
    result.set("size", lut.size);
    result.set("width", lut.width);
    result.set("height", lut.height);
    result.set("data", copy_bytes(lut.rgba));
    return result;
}

val view_bytes(const std::vector<std::uint8_t>& source) {
    if (source.empty()) return val::global("Uint8Array").new_(0);
    return val(emscripten::typed_memory_view(source.size(), source.data()));
}

const char* codec_name(const aribtlv::Codec codec) noexcept {
    switch (codec) {
    case aribtlv::Codec::Hevc: return "hevc";
    case aribtlv::Codec::AacLatm: return "aac-latm";
    case aribtlv::Codec::Ttml: return "ttml";
    }
    return "unknown";
}

const char* track_kind_name(const aribtlv::TrackKind kind) noexcept {
    switch (kind) {
    case aribtlv::TrackKind::Video: return "video";
    case aribtlv::TrackKind::Audio: return "audio";
    case aribtlv::TrackKind::Subtitle: return "subtitle";
    }
    return "unknown";
}

const char* error_code_name(const aribtlv::ErrorCode code) noexcept {
    switch (code) {
    case aribtlv::ErrorCode::MalformedInput: return "malformed-input";
    case aribtlv::ErrorCode::UnsupportedFeature: return "unsupported-feature";
    case aribtlv::ErrorCode::Discontinuity: return "discontinuity";
    case aribtlv::ErrorCode::ResourceLimit: return "resource-limit";
    }
    return "unknown";
}

bool is_initial_tlv_resynchronization(const aribtlv::Error& error) noexcept {
    return error.code == aribtlv::ErrorCode::MalformedInput &&
        error.recoverable && error.input_offset == 0 &&
        error.message == "discarded bytes while searching for a validated TLV boundary";
}

const char* duration_probe_state_name(const aribtlv::DurationProbeState state) noexcept {
    switch (state) {
    case aribtlv::DurationProbeState::Idle: return "idle";
    case aribtlv::DurationProbeState::NeedRange: return "need-range";
    case aribtlv::DurationProbeState::Complete: return "complete";
    case aribtlv::DurationProbeState::Unknown: return "unknown";
    case aribtlv::DurationProbeState::Failed: return "failed";
    case aribtlv::DurationProbeState::Cancelled: return "cancelled";
    }
    return "unknown";
}

const char* duration_probe_failure_name(const aribtlv::DurationProbeFailure failure) noexcept {
    switch (failure) {
    case aribtlv::DurationProbeFailure::None: return "none";
    case aribtlv::DurationProbeFailure::InvalidSource: return "invalid-source";
    case aribtlv::DurationProbeFailure::InvalidResponse: return "invalid-response";
    case aribtlv::DurationProbeFailure::SourceError: return "source-error";
    case aribtlv::DurationProbeFailure::NoVideo: return "no-video";
    case aribtlv::DurationProbeFailure::NoTailTimestamp: return "no-tail-timestamp";
    case aribtlv::DurationProbeFailure::RangeLimit: return "range-limit";
    case aribtlv::DurationProbeFailure::ParseError: return "parse-error";
    }
    return "unknown";
}

const char* index_state_name(const aribtlv::IndexState state) noexcept {
    switch (state) {
    case aribtlv::IndexState::Absent: return "absent";
    case aribtlv::IndexState::Loading: return "loading";
    case aribtlv::IndexState::Building: return "building";
    case aribtlv::IndexState::Partial: return "partial";
    case aribtlv::IndexState::Following: return "following";
    case aribtlv::IndexState::Complete: return "complete";
    case aribtlv::IndexState::Stale: return "stale";
    case aribtlv::IndexState::Failed: return "failed";
    }
    return "unknown";
}

const char* application_collection_state_name(
    const aribtlv::ApplicationCollectionState state) noexcept {
    switch (state) {
    case aribtlv::ApplicationCollectionState::Discovered: return "discovered";
    case aribtlv::ApplicationCollectionState::Collecting: return "collecting";
    case aribtlv::ApplicationCollectionState::Ready: return "ready";
    }
    return "discovered";
}

const char* application_lifecycle_state_name(
    const aribtlv::ApplicationLifecycleState state) noexcept {
    switch (state) {
    case aribtlv::ApplicationLifecycleState::Unsupported: return "unsupported";
    case aribtlv::ApplicationLifecycleState::AutostartPending: return "autostart-pending";
    case aribtlv::ApplicationLifecycleState::AutostartReady: return "autostart-ready";
    case aribtlv::ApplicationLifecycleState::Present: return "present";
    case aribtlv::ApplicationLifecycleState::Prefetching: return "prefetching";
    case aribtlv::ApplicationLifecycleState::Prefetched: return "prefetched";
    case aribtlv::ApplicationLifecycleState::Killed: return "killed";
    }
    return "unsupported";
}

const char* service_reset_reason_name(
    const aribtlv::ServiceStateResetReason reason) noexcept {
    switch (reason) {
    case aribtlv::ServiceStateResetReason::FullReset: return "full-reset";
    case aribtlv::ServiceStateResetReason::ServiceSelection: return "service-selection";
    }
    return "full-reset";
}

val duration_value(const aribtlv::DurationInfo duration) {
    if (duration.status == aribtlv::DurationStatus::Unknown) return val::null();
    auto result = val::object();
    result.set("value", duration.value.value);
    result.set("timescale", duration.value.timescale);
    result.set("status", duration.status == aribtlv::DurationStatus::Complete
                             ? std::string("complete")
                             : std::string("provisional"));
    return result;
}

val optional_timestamp_value(const std::optional<aribtlv::Timestamp> timestamp) {
    if (!timestamp.has_value()) return val::null();
    auto result = val::object();
    result.set("value", timestamp->value);
    result.set("timescale", timestamp->timescale);
    return result;
}

val seek_point_value(const aribtlv::SeekPoint& point) {
    auto result = val::object();
    result.set("presentationTimeUs", point.presentation_time.value);
    result.set("signallingOffset", point.signalling_offset);
    result.set("randomAccessOffset", point.random_access_offset);
    result.set("videoTrackId", point.video_track_id);
    result.set("bootstrapId", point.bootstrap_id);
    return result;
}

val broadcast_clock_value(const aribtlv::BroadcastClock& clock) {
    auto result = val::object();
    result.set("mediaTimeValue", clock.media_time.value);
    result.set("mediaTimeTimescale", clock.media_time.timescale);
    result.set("broadcastTimeValue", clock.broadcast_time.value);
    result.set("broadcastTimeTimescale", clock.broadcast_time.timescale);
    result.set("inputOffset", clock.input_offset);
    result.set("discontinuity", clock.discontinuity);
    return result;
}

val ip_data_flow_value(const aribtlv::IpDataFlow& flow) {
    auto result = val::object();
    result.set("contextId", flow.context_id);
    result.set("sequenceNumber", flow.sequence_number);
    result.set("ipVersion", flow.ip_version);
    result.set("sourceAddress", copy_bytes(flow.source_address));
    result.set("destinationAddress", copy_bytes(flow.destination_address));
    result.set("nextHeader", flow.next_header);
    result.set("sourcePort", flow.source_port);
    result.set("destinationPort", flow.destination_port);
    result.set("inputOffset", flow.input_offset);
    return result;
}

val transport_ntp_clock_value(const aribtlv::TransportNtpClock& clock) {
    auto result = val::object();
    result.set("ipVersion", clock.ip_version);
    result.set("sourceAddress", copy_bytes(clock.source_address));
    result.set("destinationAddress", copy_bytes(clock.destination_address));
    result.set("sourcePort", clock.source_port);
    result.set("destinationPort", clock.destination_port);
    result.set("leapIndicator", clock.leap_indicator);
    result.set("version", clock.version);
    result.set("mode", clock.mode);
    result.set("stratum", clock.stratum);
    result.set("poll", clock.poll);
    result.set("precision", clock.precision);
    result.set("rootDelay", clock.root_delay);
    result.set("rootDispersion", clock.root_dispersion);
    result.set("referenceIdentification", clock.reference_identification);
    result.set("referenceTimestamp", clock.reference_timestamp);
    result.set("originTimestamp", clock.origin_timestamp);
    result.set("receiveTimestamp", clock.receive_timestamp);
    result.set("transmitTimestamp", clock.transmit_timestamp);
    result.set("transmitTimeValue", clock.transmit_time.value);
    result.set("transmitTimeTimescale", clock.transmit_time.timescale);
    result.set("inputOffset", clock.input_offset);
    return result;
}

val tlv_descriptor_value(const aribtlv::TlvDescriptor& descriptor) {
    auto result = val::object();
    result.set("tag", descriptor.tag);
    result.set("payload", copy_bytes(descriptor.payload));
    result.set("sectionOffset", descriptor.section_offset);
    return result;
}

val tlv_descriptors_value(const std::vector<aribtlv::TlvDescriptor>& descriptors) {
    auto result = val::array();
    for (std::size_t index = 0; index < descriptors.size(); ++index) {
        result.set(index, tlv_descriptor_value(descriptors[index]));
    }
    return result;
}

val tlv_network_information_value(const aribtlv::TlvNetworkInformation& info) {
    auto result = val::object();
    result.set("tableId", info.table_id);
    result.set("networkId", info.network_id);
    result.set("version", info.version);
    result.set("currentNext", info.current_next);
    result.set("lastSectionNumber", info.last_section_number);
    result.set("networkDescriptors", tlv_descriptors_value(info.network_descriptors));
    auto streams = val::array();
    for (std::size_t index = 0; index < info.streams.size(); ++index) {
        const auto& source = info.streams[index];
        auto stream = val::object();
        stream.set("tlvStreamId", source.tlv_stream_id);
        stream.set("originalNetworkId", source.original_network_id);
        stream.set("descriptors", tlv_descriptors_value(source.descriptors));
        streams.set(index, stream);
    }
    result.set("streams", streams);
    result.set("inputOffset", info.input_offset);
    return result;
}

val address_map_value(const aribtlv::AddressMap& map) {
    auto result = val::object();
    result.set("tableId", map.table_id);
    result.set("tableIdExtension", map.table_id_extension);
    result.set("version", map.version);
    result.set("currentNext", map.current_next);
    result.set("lastSectionNumber", map.last_section_number);
    auto services = val::array();
    for (std::size_t index = 0; index < map.services.size(); ++index) {
        const auto& source = map.services[index];
        auto service = val::object();
        service.set("serviceId", source.service_id);
        service.set("ipVersion", source.ip_version);
        service.set("sourceAddress", copy_bytes(source.source_address));
        service.set("sourcePrefixLength", source.source_prefix_length);
        service.set("destinationAddress", copy_bytes(source.destination_address));
        service.set("destinationPrefixLength", source.destination_prefix_length);
        service.set("privateData", copy_bytes(source.private_data));
        services.set(index, service);
    }
    result.set("services", services);
    result.set("inputOffset", map.input_offset);
    return result;
}

val raw_signalling_table_value(const aribtlv::RawSignallingTable& table) {
    auto result = val::object();
    result.set("tlvPacketType", table.tlv_packet_type);
    result.set("tableId", table.table_id);
    result.set("tableIdExtension", table.table_id_extension);
    result.set("version", table.version);
    result.set("currentNext", table.current_next);
    result.set("sectionNumber", table.section_number);
    result.set("lastSectionNumber", table.last_section_number);
    result.set("data", copy_bytes(table.data));
    result.set("inputOffset", table.input_offset);
    return result;
}

val unknown_descriptor_value(const aribtlv::UnknownDescriptor& descriptor) {
    auto result = val::object();
    result.set("tableId", descriptor.table_id);
    result.set("tag", descriptor.tag);
    result.set("scope", descriptor.scope == aribtlv::DescriptorScope::Network
        ? std::string("network") : std::string("tlv-stream"));
    result.set("tlvStreamId", descriptor.tlv_stream_id
        ? val(*descriptor.tlv_stream_id) : val::null());
    result.set("originalNetworkId", descriptor.original_network_id
        ? val(*descriptor.original_network_id) : val::null());
    result.set("sectionOffset", descriptor.section_offset);
    result.set("payload", copy_bytes(descriptor.payload));
    result.set("inputOffset", descriptor.input_offset);
    return result;
}

val presentation_regions_value(
    const std::vector<aribtlv::MpuPresentationRegion>& regions) {
    auto result = val::array();
    for (std::size_t index = 0; index < regions.size(); ++index) {
        auto region = val::object();
        region.set("mpuSequenceNumber", regions[index].mpu_sequence_number);
        region.set("layoutNumber", regions[index].layout_number);
        region.set("regionNumber", regions[index].region_number);
        result.set(index, region);
    }
    return result;
}

val asset_groups_value(const std::vector<aribtlv::AssetGroupInfo>& groups) {
    auto result = val::array();
    for (std::size_t index = 0; index < groups.size(); ++index) {
        auto group = val::object();
        group.set("groupIdentification", groups[index].group_identification);
        group.set("selectionLevel", groups[index].selection_level);
        result.set(index, group);
    }
    return result;
}

val track_info_value(const aribtlv::TrackInfo& info) {
    auto event = val::object();
    event.set("trackId", info.track_id);
    event.set("contextId", info.context_id);
    event.set("packetId", info.packet_id);
    event.set("kind", std::string(track_kind_name(info.kind)));
    event.set("codec", std::string(codec_name(info.codec)));
    event.set("language", info.language);
    event.set("componentTag", info.component_tag);
    event.set("timescale", info.timescale);
    event.set("assetGroups", asset_groups_value(info.asset_groups));
    event.set("presentationRegions", presentation_regions_value(info.presentation_regions));
    if (info.video.has_value()) {
        auto video = val::object();
        video.set("hdrWcgIdc", info.video->hdr_wcg_idc.has_value()
            ? val(*info.video->hdr_wcg_idc) : val::null());
        video.set("videoTransferCharacteristics",
                  info.video->video_transfer_characteristics.has_value()
                      ? val(*info.video->video_transfer_characteristics)
                      : val::null());
        event.set("video", video);
    }
    return event;
}

val application_info_value(const aribtlv::ApplicationInfo& info) {
    auto event = val::object();
    event.set("contextId", info.context_id);
    event.set("sourcePacketId", info.source_packet_id);
    event.set("applicationType", info.application_type);
    event.set("organizationId", info.organization_id);
    event.set("applicationId", info.application_id);
    event.set("controlCode", info.control_code);
    event.set("version", info.version);
    event.set("currentNext", info.current_next);
    event.set("sectionNumber", info.section_number);
    event.set("lastSectionNumber", info.last_section_number);
    event.set("presentApplicationPriority", info.present_application_priority);
    event.set("applicationPriority", info.application_priority);
    event.set("entryPath", info.entry_path);
    event.set("inputOffset", info.input_offset);
    return event;
}

val layout_configuration_value(const aribtlv::LayoutConfiguration& info) {
    auto result = val::object();
    result.set("contextId", info.context_id);
    result.set("sourcePacketId", info.source_packet_id);
    result.set("version", info.version);
    result.set("inputOffset", info.input_offset);
    if (info.background_color_rgb.has_value()) {
        result.set("backgroundColorRgb", *info.background_color_rgb);
    } else {
        result.set("backgroundColorRgb", val::null());
    }
    auto devices = val::array();
    for (std::size_t device_index = 0; device_index < info.devices.size(); ++device_index) {
        const auto& source = info.devices[device_index];
        auto device = val::object();
        device.set("layoutNumber", source.layout_number);
        device.set("deviceId", source.device_id);
        auto regions = val::array();
        for (std::size_t region_index = 0; region_index < source.regions.size(); ++region_index) {
            const auto& source_region = source.regions[region_index];
            auto region = val::object();
            region.set("regionNumber", source_region.region_number);
            region.set("leftTopPosX", source_region.left_top_pos_x);
            region.set("leftTopPosY", source_region.left_top_pos_y);
            region.set("rightDownPosX", source_region.right_down_pos_x);
            region.set("rightDownPosY", source_region.right_down_pos_y);
            region.set("layerOrder", source_region.layer_order);
            regions.set(region_index, region);
        }
        device.set("regions", regions);
        devices.set(device_index, device);
    }
    result.set("devices", devices);
    return result;
}

val event_info_value(const aribtlv::EventInfo& info) {
    auto result = val::object();
    result.set("contextId", info.context_id);
    result.set("sourcePacketId", info.source_packet_id);
    result.set("tableId", info.table_id);
    result.set("version", info.version);
    result.set("currentNext", info.current_next);
    result.set("sectionNumber", info.section_number);
    result.set("lastSectionNumber", info.last_section_number);
    result.set("serviceId", info.service_id);
    result.set("tlvStreamId", info.tlv_stream_id);
    result.set("originalNetworkId", info.original_network_id);
    result.set("eventId", info.event_id);
    if (info.start_time_unix_milliseconds.has_value()) {
        result.set("startTimeUnixMilliseconds",
                   static_cast<double>(*info.start_time_unix_milliseconds));
    } else {
        result.set("startTimeUnixMilliseconds", val::null());
    }
    if (info.duration_seconds.has_value()) {
        result.set("durationSeconds", *info.duration_seconds);
    } else {
        result.set("durationSeconds", val::null());
    }
    result.set("runningStatus", info.running_status);
    result.set("freeCaMode", info.free_ca_mode);
    result.set("language", info.language);
    result.set("title", info.title);
    result.set("hdrProgrammeIcon", info.hdr_programme_icon);
    result.set("videoPresentationHint",
               aribtlv::video_presentation_hint(info) ==
                       aribtlv::VideoPresentationHint::Hdr
                   ? "hdr"
                   : "unknown");
    result.set("description", info.description);
    result.set("extendedDescription", info.extended_description);
    auto extended_items = val::array();
    for (std::size_t index = 0; index < info.extended_items.size(); ++index) {
        auto item = val::object();
        item.set("description", info.extended_items[index].description);
        item.set("value", info.extended_items[index].value);
        extended_items.set(index, item);
    }
    result.set("extendedItems", extended_items);
    auto genres = val::array();
    for (std::size_t index = 0; index < info.genres.size(); ++index) {
        auto genre = val::object();
        genre.set("level1", info.genres[index].level1);
        genre.set("level2", info.genres[index].level2);
        genre.set("user1", info.genres[index].user1);
        genre.set("user2", info.genres[index].user2);
        genres.set(index, genre);
    }
    result.set("genres", genres);
    auto ratings = val::array();
    for (std::size_t index = 0; index < info.parental_ratings.size(); ++index) {
        auto rating = val::object();
        rating.set("countryCode", info.parental_ratings[index].country_code);
        rating.set("rating", info.parental_ratings[index].rating);
        ratings.set(index, rating);
    }
    result.set("parentalRatings", ratings);
    auto audio_components = val::array();
    for (std::size_t index = 0; index < info.audio_components.size(); ++index) {
        const auto& source = info.audio_components[index];
        auto component = val::object();
        component.set("componentType", source.audio.component_type);
        component.set("componentTag", source.audio.component_tag);
        component.set("channelLayout", static_cast<unsigned>(source.audio.channel_layout));
        component.set("channels", aribtlv::audio_channel_count(source.audio.channel_layout));
        component.set("streamType", source.audio.stream_type);
        component.set("multilingual", source.audio.es_multi_lingual);
        component.set("mainComponent", source.audio.main_component);
        component.set("sampleRate", source.audio.sample_rate);
        component.set("language", source.language);
        component.set("secondaryLanguage", source.audio.secondary_language);
        component.set("text", source.text);
        audio_components.set(index, component);
    }
    result.set("audioComponents", audio_components);
    if (info.series.has_value()) {
        auto series = val::object();
        series.set("seriesId", info.series->series_id);
        series.set("repeatLabel", info.series->repeat_label);
        series.set("programPattern", info.series->program_pattern);
        series.set("expireDateMjd", info.series->expire_date_mjd.has_value()
            ? val(*info.series->expire_date_mjd) : val::null());
        series.set("episodeNumber", info.series->episode_number);
        series.set("lastEpisodeNumber", info.series->last_episode_number);
        series.set("name", info.series->name);
        result.set("series", series);
    } else {
        result.set("series", val::null());
    }
    result.set("inputOffset", info.input_offset);
    return result;
}

val mh_sdt_value(const aribtlv::MhSdtSnapshot& snapshot) {
    auto result = val::object();
    result.set("contextId", snapshot.context_id);
    result.set("sourcePacketId", snapshot.source_packet_id);
    result.set("tableId", snapshot.table_id);
    result.set("tlvStreamId", snapshot.tlv_stream_id);
    result.set("originalNetworkId", snapshot.original_network_id);
    result.set("version", snapshot.version);
    result.set("currentNext", snapshot.current_next);
    result.set("inputOffset", snapshot.input_offset);
    auto services = val::array();
    for (std::size_t index = 0; index < snapshot.services.size(); ++index) {
        const auto& info = snapshot.services[index];
        auto service = val::object();
        service.set("serviceId", info.service_id);
        service.set("eitUserDefinedFlags", info.eit_user_defined_flags);
        service.set("eitSchedule", info.eit_schedule);
        service.set("eitPresentFollowing", info.eit_present_following);
        service.set("runningStatus", info.running_status);
        service.set("freeCaMode", info.free_ca_mode);
        service.set("serviceType", info.service_type);
        service.set("providerName", info.provider_name);
        service.set("serviceName", info.service_name);
        services.set(index, service);
    }
    result.set("services", services);
    return result;
}

val mh_tot_value(const aribtlv::MhTotInfo& info) {
    auto result = val::object();
    result.set("contextId", info.context_id);
    result.set("sourcePacketId", info.source_packet_id);
    result.set("timeUnixMilliseconds", static_cast<double>(info.time_unix_milliseconds));
    result.set("inputOffset", info.input_offset);
    auto offsets = val::array();
    for (std::size_t index = 0; index < info.local_time_offsets.size(); ++index) {
        const auto& source = info.local_time_offsets[index];
        auto offset = val::object();
        offset.set("countryCode", source.country_code);
        offset.set("countryRegionId", source.country_region_id);
        offset.set("polarity", source.polarity);
        offset.set("offsetMinutes", source.offset_minutes);
        offset.set("changeTimeUnixMilliseconds",
                   source.change_time_unix_milliseconds.has_value()
                       ? val(static_cast<double>(*source.change_time_unix_milliseconds))
                       : val::null());
        offset.set("nextOffsetMinutes", source.next_offset_minutes);
        offsets.set(index, offset);
    }
    result.set("localTimeOffsets", offsets);
    return result;
}

val stream_event_value(const aribtlv::StreamEvent& event) {
    auto result = val::object();
    result.set("contextId", event.context_id);
    result.set("sourcePacketId", event.source_packet_id);
    result.set("eventMessageTag", event.event_message_tag);
    result.set("dataEventId", event.data_event_id);
    result.set("messageGroupId", event.message_group_id);
    result.set("messageVersion", event.message_version);
    result.set("currentNext", event.current_next);
    result.set("sectionNumber", event.section_number);
    result.set("lastSectionNumber", event.last_section_number);
    result.set("timeMode", event.time_mode);
    result.set("timeValue", event.time_value);
    result.set("utcReference", event.utc_reference.has_value()
        ? val(*event.utc_reference) : val::null());
    result.set("nptReference", event.npt_reference.has_value()
        ? val(*event.npt_reference) : val::null());
    result.set("messageType", event.message_type);
    result.set("rawMessageId", event.raw_message_id);
    result.set("messageId", event.message_id);
    result.set("privateData", copy_bytes(event.private_data));
    result.set("inputOffset", event.input_offset);
    return result;
}

val viewer_participation_value(
    const aribtlv::ViewerParticipationNotification& notification) {
    auto result = val::object();
    result.set("contextId", notification.context_id);
    result.set("sourcePacketId", notification.source_packet_id);
    result.set("eventMessageTag", notification.event_message_tag);
    result.set("dataEventId", notification.data_event_id);
    result.set("messageGroupId", notification.message_group_id);
    result.set("version", notification.version);
    result.set("currentNext", notification.current_next);
    result.set("sectionNumber", notification.section_number);
    result.set("lastSectionNumber", notification.last_section_number);
    result.set("inputOffset", notification.input_offset);
    return result;
}

class WasmDurationProbe final {
public:
    bool begin(const std::uint64_t source_size, const val& js_options) {
        aribtlv::DurationProbeOptions options;
        if (!js_options.isNull() && !js_options.isUndefined()) {
            assign_if_present(js_options, "initialRangeSize", options.initial_range_size);
            assign_if_present(js_options, "maxRangeSize", options.max_range_size);
            assign_optional_if_present(js_options, "serviceContextId",
                                       options.service_context_id);
            assign_optional_if_present(js_options, "videoPacketId", options.video_packet_id);
        }
        return probe_.begin(source_size, options);
    }

    val nextRange() const {
        const auto request = probe_.nextRange();
        if (!request.has_value()) return val::null();
        auto result = val::object();
        result.set("generation", request->generation);
        result.set("requestId", request->request_id);
        result.set("offset", request->offset);
        result.set("length", request->length);
        return result;
    }

    bool pushRange(const std::uint64_t request_id, const std::uint64_t absolute_offset,
                   const val& bytes, const bool end_of_range) {
        if (bytes.isNull() || bytes.isUndefined()) return false;
        const auto byte_length = bytes["byteLength"].as<std::size_t>();
        std::vector<std::uint8_t> copy(byte_length);
        if (byte_length != 0) {
            val(emscripten::typed_memory_view(copy.size(), copy.data())).call<void>("set", bytes);
        }
        return probe_.pushRange(request_id, absolute_offset, copy.data(), copy.size(), end_of_range);
    }

    bool pushRangeFromHeap(const std::uint64_t request_id,
                           const std::uint64_t absolute_offset,
                           const std::uintptr_t address, const std::size_t size,
                           const bool end_of_range) {
        const auto heap_size = static_cast<std::uintptr_t>(emscripten_get_heap_size());
        if (address > heap_size || size > heap_size - address) return false;
        return probe_.pushRange(request_id, absolute_offset,
                                reinterpret_cast<const std::uint8_t*>(address), size,
                                end_of_range);
    }

    bool failRange(const std::uint64_t request_id) { return probe_.failRange(request_id); }
    void cancel() { probe_.cancel(); }
    std::string state() const { return duration_probe_state_name(probe_.state()); }
    std::string failure() const { return duration_probe_failure_name(probe_.failure()); }
    std::uint64_t generation() const { return probe_.generation(); }
    std::uint64_t transferredBytes() const { return probe_.transferredBytes(); }

    val duration() const {
        return duration_value(probe_.duration());
    }

    val presentationStart() const {
        return optional_timestamp_value(probe_.presentationStart());
    }

    val presentationEnd() const {
        return optional_timestamp_value(probe_.presentationEnd());
    }

    val selectedVideoPacketId() const {
        const auto packet_id = probe_.selectedVideoPacketId();
        return packet_id.has_value() ? val(*packet_id) : val::null();
    }

    val presentationEndVideoPacketId() const {
        const auto packet_id = probe_.presentationEndVideoPacketId();
        return packet_id.has_value() ? val(*packet_id) : val::null();
    }

private:
    template <typename T>
    static void assign_if_present(const val& object, const char* name, T& destination) {
        const auto value = object[name];
        if (!value.isNull() && !value.isUndefined()) destination = value.as<T>();
    }

    template <typename T>
    static void assign_optional_if_present(const val& object, const char* name,
                                           std::optional<T>& destination) {
        const auto value = object[name];
        if (!value.isNull() && !value.isUndefined()) destination = value.as<T>();
    }

    aribtlv::DurationProbe probe_;
};

#include "demuxer.hpp"

} // namespace

EMSCRIPTEN_BINDINGS(tlvdemux_wasm) {
    emscripten::class_<WasmDemuxer>("TlvDemuxer")
        .constructor<val>()
        .function("push", &WasmDemuxer::push)
        .function("pushFromHeap", &WasmDemuxer::pushFromHeap)
        .function("flush", &WasmDemuxer::flush)
        .function("reset", &WasmDemuxer::reset)
        .function("reposition", &WasmDemuxer::reposition)
        .function("selectService", &WasmDemuxer::selectService)
        .function("selectTrack", &WasmDemuxer::selectTrack)
        .function("switchAudioTrack", &WasmDemuxer::switchAudioTrack)
        .function("switchLayer", &WasmDemuxer::switchLayer)
        .function("switchLayerAtPlaybackEntry",
                  &WasmDemuxer::switchLayerAtPlaybackEntry)
        .function("configureAutomaticLayerSwitch",
                  &WasmDemuxer::configureAutomaticLayerSwitch)
        .function("suspendAutomaticLayerSwitch",
                  &WasmDemuxer::suspendAutomaticLayerSwitch)
        .function("clearAutomaticLayerSwitch",
                  &WasmDemuxer::clearAutomaticLayerSwitch)
        .function("setMseTimestampOffset", &WasmDemuxer::setMseTimestampOffset)
        .function("setMseRecordedSeekConcealmentTarget",
                  &WasmDemuxer::setMseRecordedSeekConcealmentTarget)
        .function("getMseRecordedSeekLandingEvidence",
                  &WasmDemuxer::getMseRecordedSeekLandingEvidence)
        .function("beginMseRecordedSeek", &WasmDemuxer::beginMseRecordedSeek)
        .function("flushMseRecordedSeekLanding",
                  &WasmDemuxer::flushMseRecordedSeekLanding)
        .function("finishMseRecordedSeek", &WasmDemuxer::finishMseRecordedSeek)
        .function("cancelMseRecordedSeek", &WasmDemuxer::cancelMseRecordedSeek)
        .function("setMsePlaybackPosition",
                  &WasmDemuxer::setMsePlaybackPosition)
        .function("setMseSdrInHlg", &WasmDemuxer::setMseSdrInHlg)
        .function("setMseToneMappingMode", &WasmDemuxer::setMseToneMappingMode)
        .function("setMseHlgOutputSupported",
                  &WasmDemuxer::setMseHlgOutputSupported)
        .function("setMseEdid", &WasmDemuxer::setMseEdid)
        .function("setMseOutputConnected", &WasmDemuxer::setMseOutputConnected)
        .function("mseOutputGeneration", &WasmDemuxer::mseOutputGeneration)
        .function("hlgSdrToneMappingLut", &WasmDemuxer::hlgSdrToneMappingLut)
        .function("hlgSdrColorLut", &WasmDemuxer::hlgSdrColorLut)
        .function("hlgSdrPrototypeColorLut", &WasmDemuxer::hlgSdrPrototypeColorLut)
        .function("setMseOutputEnabled", &WasmDemuxer::setMseOutputEnabled)
        .function("setSubtitlePassthroughEnabled", &WasmDemuxer::setSubtitlePassthroughEnabled)
        .function("drainApplicationResources", &WasmDemuxer::drainApplicationResources)
        .function("startIndex", &WasmDemuxer::startIndex)
        .function("finalizeIndex", &WasmDemuxer::finalizeIndex)
        .function("indexState", &WasmDemuxer::indexState)
        .function("indexDuration", &WasmDemuxer::indexDuration)
        .function("setIndexDuration", &WasmDemuxer::setIndexDuration)
        .function("seekPointCount", &WasmDemuxer::seekPointCount)
        .function("indexedVideoTrack", &WasmDemuxer::indexedVideoTrack)
        .function("previousSync", &WasmDemuxer::previousSync)
        .function("seekPointsFor", &WasmDemuxer::seekPointsFor)
        .function("estimateOffset", &WasmDemuxer::estimateOffset)
        .function("applicationResources", &WasmDemuxer::applicationResources)
        .function("applicationResource", &WasmDemuxer::applicationResource)
        .function("applicationEntry", &WasmDemuxer::applicationEntry)
        .function("applications", &WasmDemuxer::applications)
        .function("applicationResourceGeneration",
                  &WasmDemuxer::applicationResourceGeneration)
        .function("broadcastClock", &WasmDemuxer::broadcastClock);

    emscripten::class_<WasmDurationProbe>("DurationProbe")
        .constructor<>()
        .function("begin", &WasmDurationProbe::begin)
        .function("nextRange", &WasmDurationProbe::nextRange)
        .function("pushRange", &WasmDurationProbe::pushRange)
        .function("pushRangeFromHeap", &WasmDurationProbe::pushRangeFromHeap)
        .function("failRange", &WasmDurationProbe::failRange)
        .function("cancel", &WasmDurationProbe::cancel)
        .function("state", &WasmDurationProbe::state)
        .function("failure", &WasmDurationProbe::failure)
        .function("duration", &WasmDurationProbe::duration)
        .function("presentationStart", &WasmDurationProbe::presentationStart)
        .function("presentationEnd", &WasmDurationProbe::presentationEnd)
        .function("selectedVideoPacketId", &WasmDurationProbe::selectedVideoPacketId)
        .function("presentationEndVideoPacketId",
                  &WasmDurationProbe::presentationEndVideoPacketId)
        .function("generation", &WasmDurationProbe::generation)
        .function("transferredBytes", &WasmDurationProbe::transferredBytes);
}

int main() {
    return 0;
}
