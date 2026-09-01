class WasmDemuxer final : public aribtlv::Sink,
                          public aribtlv::ApplicationResourceSink {
public:
    explicit WasmDemuxer(val callbacks)
        : callbacks_(std::move(callbacks)), application_assembler_(*this),
          demuxer_(*this, media_limits()),
          mse_remuxer_(callbacks_, mse_max_audio_channels(callbacks_),
                       [this](const tlvdemux::MseLayerSwitchCancelled& cancelled) {
                           restoreLayerSelectionState(cancelled);
                       }) {
        mse_enabled_ = has_callback("onMseInit") || has_callback("onMseSegment") ||
            has_callback("onMseVideoProperties");
    }

    bool push(const val& bytes) {
        if (bytes.isNull() || bytes.isUndefined()) return false;
        const auto byte_length = bytes["byteLength"].as<std::size_t>();
        std::vector<std::uint8_t> copy(byte_length);
        if (byte_length != 0) {
            val(emscripten::typed_memory_view(copy.size(), copy.data())).call<void>("set", bytes);
        }
        demuxer_.push(copy.data(), copy.size());
        return true;
    }

    bool pushFromHeap(const std::uintptr_t address, const std::size_t size) {
        const auto heap_size = static_cast<std::uintptr_t>(emscripten_get_heap_size());
        if (address > heap_size || size > heap_size - address) return false;
        demuxer_.push(reinterpret_cast<const std::uint8_t*>(address), size);
        return true;
    }

    void flush() {
        demuxer_.flush();
        if (mse_enabled_) restoreLayerSelection(mse_remuxer_.endOfStream());
    }
    void reset() {
        reset_application_resources();
        video_track_ids_.clear();
        hlg_video_track_ids_.clear();
        explicit_sdr_video_track_ids_.clear();
        presentation_policy_.clear_programme_hint();
        const auto cancelled = mse_enabled_ ? mse_remuxer_.reset() : std::nullopt;
        demuxer_.reset();
        restoreLayerSelection(cancelled);
        if (index_active_) recording_index_.begin(index_growing_);
    }

    void reposition(const std::uint64_t input_offset, const bool preserve_timeline) {
        // A media seek is not a service change. Drop only incomplete carousel
        // assembly state so fragments from both byte positions cannot mix,
        // while retaining files already published into the VFS. Receivers can
        // therefore open data broadcasting immediately after a seek and keep
        // refreshing it from later carousel cycles.
        restart_application_assembly();
        const auto cancelled = mse_enabled_ ? mse_remuxer_.reposition() : std::nullopt;
        demuxer_.reposition(aribtlv::RepositionOptions{input_offset, preserve_timeline});
        restoreLayerSelection(cancelled);
    }

    void selectService(const val& context_id) {
        reset_application_resources();
        video_track_ids_.clear();
        hlg_video_track_ids_.clear();
        explicit_sdr_video_track_ids_.clear();
        presentation_policy_.clear_programme_hint();
        demuxer_.selectService(optional_number<std::uint32_t>(context_id));
        if (index_active_) recording_index_.begin(index_growing_);
    }

    void selectTrack(const std::string& kind, const val& track_id) {
        std::optional<aribtlv::TrackKind> parsed_kind;
        if (kind == "video") parsed_kind = aribtlv::TrackKind::Video;
        if (kind == "audio") parsed_kind = aribtlv::TrackKind::Audio;
        if (kind == "subtitle") parsed_kind = aribtlv::TrackKind::Subtitle;
        if (!parsed_kind.has_value()) return;
        const auto selected = optional_number<std::uint64_t>(track_id);
        if (mse_enabled_ && *parsed_kind == aribtlv::TrackKind::Audio) {
            // MSE keeps a bounded compressed-frame history for the other audio
            // tracks. Preserve the public selected-track callback contract
            // below while allowing the remuxer to observe those access units.
            demuxer_.selectTrack(*parsed_kind, std::nullopt);
        } else if (mse_enabled_ && *parsed_kind == aribtlv::TrackKind::Video) {
            // Let the MSE layer observe all video candidates so the caller can
            // detect a later RAP on another asset layer. MseRemuxer still
            // filters output to selected_video_track_.
            demuxer_.selectTrack(*parsed_kind, std::nullopt);
        } else {
            demuxer_.selectTrack(*parsed_kind, selected);
        }
        if (mse_enabled_) mse_remuxer_.selectTrack(*parsed_kind, selected);
        if (*parsed_kind == aribtlv::TrackKind::Video) selected_video_track_ = selected;
        if (*parsed_kind == aribtlv::TrackKind::Audio) selected_audio_track_ = selected;
        if (*parsed_kind == aribtlv::TrackKind::Video && index_active_ &&
            recording_index_.state() == aribtlv::IndexState::Building) {
            recording_index_.selectVideoTrack(selected);
        }
    }

    val switchAudioTrack(const std::uint64_t track_id,
                         const std::int64_t earliest_presentation_time_us) {
        if (!mse_enabled_) return val::null();
        const auto boundary = mse_remuxer_.switchAudioTrack(
            track_id, earliest_presentation_time_us);
        if (!boundary.has_value()) return val::null();
        selected_audio_track_ = track_id;
        return val(*boundary);
    }

    bool switchLayer(const std::uint64_t video_track_id,
                     const std::uint64_t audio_track_id,
                     const std::int64_t earliest_presentation_time_us) {
        if (!mse_enabled_ || !mse_remuxer_.switchLayer(
                video_track_id, audio_track_id,
                earliest_presentation_time_us)) return false;
        selected_audio_track_ = audio_track_id;
        selected_video_track_ = video_track_id;
        demuxer_.selectTrack(aribtlv::TrackKind::Video, std::nullopt);
        if (index_active_ && recording_index_.state() == aribtlv::IndexState::Building) {
            recording_index_.switchVideoTrack(video_track_id);
        }
        return true;
    }

    bool switchLayerAtPlaybackEntry(
        const std::uint64_t video_track_id,
        const std::uint64_t audio_track_id,
        const std::int64_t playback_entry_time_us) {
        if (!mse_enabled_ || !mse_remuxer_.switchLayerAtPlaybackEntry(
                video_track_id, audio_track_id,
                playback_entry_time_us)) return false;
        selected_audio_track_ = audio_track_id;
        selected_video_track_ = video_track_id;
        demuxer_.selectTrack(aribtlv::TrackKind::Video, std::nullopt);
        if (index_active_ && recording_index_.state() == aribtlv::IndexState::Building) {
            recording_index_.switchVideoTrack(video_track_id);
        }
        return true;
    }

    void synchronizeAcceptedLayerSwitch(
        const tlvdemux::MseAutomaticLayerSwitchAccepted& accepted) {
        selected_audio_track_ = accepted.audio_track_id;
        selected_video_track_ = accepted.video_track_id;
        demuxer_.selectTrack(aribtlv::TrackKind::Video, std::nullopt);
        if (index_active_ && recording_index_.state() == aribtlv::IndexState::Building) {
            recording_index_.switchVideoTrack(accepted.video_track_id);
        }
    }

    void configureAutomaticLayerSwitch(
        const std::uint64_t preferred_video_track_id,
        const std::uint64_t preferred_audio_track_id,
        const std::uint64_t fallback_video_track_id,
        const std::uint64_t fallback_audio_track_id) {
        if (!mse_enabled_) return;
        mse_remuxer_.configureAutomaticLayerSwitch(tlvdemux::MseAutomaticLayerPair{
            preferred_video_track_id,
            preferred_audio_track_id,
            fallback_video_track_id,
            fallback_audio_track_id,
        });
    }

    void suspendAutomaticLayerSwitch(
        const std::uint64_t preferred_video_track_id,
        const std::uint64_t preferred_audio_track_id,
        const std::uint64_t fallback_video_track_id,
        const std::uint64_t fallback_audio_track_id) {
        mse_remuxer_.suspendAutomaticLayerSwitch(tlvdemux::MseAutomaticLayerPair{
            preferred_video_track_id,
            preferred_audio_track_id,
            fallback_video_track_id,
            fallback_audio_track_id,
        });
    }

    void clearAutomaticLayerSwitch() {
        mse_remuxer_.clearAutomaticLayerSwitch();
    }

    void setMseTimestampOffset(const std::int64_t timestamp_offset_us) {
        mse_remuxer_.setTimestampOffset(timestamp_offset_us);
    }

    void setMseRecordedSeekConcealmentTarget(
        const val& presentation_time_us) {
        mse_remuxer_.setRecordedSeekConcealmentTarget(
            optional_number<std::int64_t>(presentation_time_us));
    }

    val getMseRecordedSeekLandingEvidence() const {
        const auto evidence = mse_remuxer_.recordedSeekLandingEvidence();
        auto result = val::object();
        result.set("landingMode", evidence.landing_mode ==
                tlvdemux::MseRecordedSeekLandingMode::HeldFrame
            ? "held-frame" : "exact");
        result.set("heldFrameTimeUs", evidence.held_frame_time_us.has_value()
            ? val(*evidence.held_frame_time_us) : val::null());
        result.set("recoveryTimeUs", evidence.recovery_time_us.has_value()
            ? val(*evidence.recovery_time_us) : val::null());
        return result;
    }

    void beginMseRecordedSeek() {
        if (mse_enabled_) mse_remuxer_.beginMseRecordedSeek();
    }

    void finishMseRecordedSeek(const std::int64_t playback_position_us) {
        if (mse_enabled_) mse_remuxer_.finishMseRecordedSeek(playback_position_us);
    }

    void cancelMseRecordedSeek() {
        if (mse_enabled_) mse_remuxer_.cancelMseRecordedSeek();
    }

    void flushMseRecordedSeekAudio() {
        if (mse_enabled_) mse_remuxer_.flushRecordedSeekAudio();
    }

    void flushMseRecordedSeekLanding() {
        if (mse_enabled_) mse_remuxer_.flush();
    }

    void setMsePlaybackPosition(const std::int64_t presentation_time_us) {
        if (mse_enabled_) mse_remuxer_.setPlaybackPosition(presentation_time_us);
    }

    void setMseSdrInHlg(const std::uint64_t video_track_id, const bool enabled) {
        if (mse_enabled_) mse_remuxer_.setSdrInHlg(video_track_id, enabled);
    }

    void setMseToneMappingMode(const std::string& mode) {
        presentation_policy_.set_mode(mode);
        output_state_.set_hdr_mode(mode == "force" ? tlvdemux::MseHdrOutputMode::Hdr10 :
            mode == "prototype" ? tlvdemux::MseHdrOutputMode::Hlg :
            mode == "off" ? tlvdemux::MseHdrOutputMode::Sdr :
            tlvdemux::MseHdrOutputMode::Auto);
        emit_mse_output_state();
        for (const auto track_id : video_track_ids_) apply_video_presentation_policy(track_id);
    }

    void setMseHlgOutputSupported(const bool supported) {
        auto capabilities = output_state_.state().capabilities;
        capabilities.edid_valid = true;
        capabilities.hlg_eotf = supported;
        capabilities.hdr_support = supported || capabilities.pq_eotf;
        output_state_.update(capabilities, output_state_.state().connected);
        presentation_policy_.set_output_capabilities(capabilities);
        emit_mse_output_state();
        for (const auto track_id : video_track_ids_) {
            apply_video_presentation_policy(track_id);
        }
    }

    void setMseEdid(const val& bytes) {
        if (bytes.isNull() || bytes.isUndefined()) return;
        const auto byte_length = bytes["byteLength"].as<std::size_t>();
        std::vector<std::uint8_t> copy(byte_length);
        if (byte_length != 0) {
            val(emscripten::typed_memory_view(copy.size(), copy.data())).call<void>("set", bytes);
        }
        const auto capabilities = tlvdemux::parse_mse_output_capabilities(copy);
        output_state_.update(capabilities, true);
        presentation_policy_.set_output_capabilities(capabilities);
        emit_mse_output_state();
        for (const auto track_id : video_track_ids_) apply_video_presentation_policy(track_id);
    }

    void setMseOutputConnected(const bool connected) {
        const auto capabilities = output_state_.state().capabilities;
        if (!output_state_.update(capabilities, connected)) return;
        presentation_policy_.set_output_capabilities(
            connected ? capabilities : tlvdemux::MseOutputCapabilities{});
        emit_mse_output_state();
        for (const auto track_id : video_track_ids_) apply_video_presentation_policy(track_id);
    }

    std::uint64_t mseOutputGeneration() const noexcept {
        return output_state_.state().generation;
    }

    val hlgSdrToneMappingLut() const {
        return hlg_sdr_tone_mapping_lut_value();
    }

    val hlgSdrColorLut() const {
        return hlg_sdr_color_lut_value();
    }

    val hlgSdrPrototypeColorLut() const {
        return hlg_sdr_prototype_color_lut_value();
    }

    void setMseOutputEnabled(const bool enabled) {
        mse_remuxer_.setOutputEnabled(enabled);
    }

    void setSubtitlePassthroughEnabled(const bool enabled) {
        demuxer_.setSubtitlePassthroughEnabled(enabled);
    }

    bool drainApplicationResources(std::size_t max_events) {
        if (max_events == 0) max_events = application_events_.size();
        while (max_events-- != 0 && !application_events_.empty()) {
            auto event = std::move(application_events_.front());
            application_events_.pop_front();
            std::visit([this](auto&& value) { consume_application_event(std::move(value)); },
                       std::move(event));
        }
        return !application_events_.empty();
    }

    void startIndex(const bool growing) {
        recording_index_.begin(growing);
        index_active_ = true;
        index_growing_ = growing;
    }

    bool finalizeIndex() {
        return index_active_ && recording_index_.finalize();
    }

    std::string indexState() const {
        return index_state_name(recording_index_.state());
    }

    val indexDuration() const { return duration_value(recording_index_.duration()); }
    bool setIndexDuration(const std::int64_t duration_us) {
        if (!index_active_ || duration_us < 0) return false;
        return recording_index_.updateDuration(aribtlv::DurationInfo{
            aribtlv::Timestamp{duration_us, 1000000},
            aribtlv::DurationStatus::Provisional,
        });
    }
    std::size_t seekPointCount() const { return recording_index_.seekPoints().size(); }
    val indexedVideoTrack() const {
        const auto track = recording_index_.selectedVideoTrack();
        return track.has_value() ? val(*track) : val::null();
    }

    val previousSync(const std::int64_t target_us) const {
        const auto point = recording_index_.previousSync(
            aribtlv::Timestamp{target_us, 1000000});
        return point.has_value() ? seek_point_value(*point) : val::null();
    }

    val seekPointsFor(const std::int64_t target_us) const {
        const auto points = recording_index_.seekPointsFor(
            aribtlv::Timestamp{target_us, 1000000});
        if (!points.has_value()) return val::null();
        auto result = val::object();
        result.set("first", seek_point_value(points->first));
        result.set("second", points->second.has_value()
                                 ? seek_point_value(*points->second)
                                 : val::null());
        return result;
    }

    val estimateOffset(const std::int64_t target_us,
                       const std::uint64_t source_size) const {
        const auto offset = recording_index_.estimateOffset(
            aribtlv::Timestamp{target_us, 1000000}, source_size);
        return offset.has_value() ? val(*offset) : val::null();
    }

    val applicationResources(const val& context_id) const {
        const auto resources = application_resources_.list(
            optional_number<std::uint32_t>(context_id));
        auto result = val::array();
        for (std::size_t index = 0; index < resources.size(); ++index) {
            result.set(index, application_resource_metadata_event(resources[index]));
        }
        return result;
    }

    val applicationResource(const std::uint32_t context_id,
                            const std::string& path) const {
        const auto resource = application_resources_.get(context_id, path);
        if (!resource) return val::null();
        return application_resource_event(*resource, copy_bytes(resource->data));
    }

    val applicationEntry(const std::uint32_t context_id) const {
        const auto path = application_resources_.entryPath(context_id);
        return path.has_value() ? val(*path) : val::null();
    }

    val applications() const {
        const auto applications = application_resources_.applications();
        auto result = val::array();
        for (std::size_t index = 0; index < applications.size(); ++index) {
            result.set(index, application_state_event(applications[index]));
        }
        return result;
    }

    std::uint64_t applicationResourceGeneration() const {
        return application_resources_.generation();
    }

    val broadcastClock() const {
        const auto clock = demuxer_.broadcastClock();
        return clock.has_value() ? broadcast_clock_value(*clock) : val::null();
    }

    void onService(const aribtlv::ServiceInfo& info) override {
        auto event = val::object();
        event.set("contextId", info.context_id);
        event.set("packageId", copy_bytes(info.package_id));
        emit("onService", event);
    }

    void onIpDataFlow(const aribtlv::IpDataFlow& flow) override {
        emit("onIpDataFlow", ip_data_flow_value(flow));
    }

    void onTransportNtpClock(const aribtlv::TransportNtpClock& clock) override {
        emit("onTransportNtpClock", transport_ntp_clock_value(clock));
    }

    void onTlvNetworkInformation(
        const aribtlv::TlvNetworkInformation& info) override {
        emit("onTlvNetworkInformation", tlv_network_information_value(info));
    }

    void onAddressMap(const aribtlv::AddressMap& map) override {
        emit("onAddressMap", address_map_value(map));
    }

    void onRawSignallingTable(aribtlv::RawSignallingTable&& table) override {
        emit("onRawSignallingTable", raw_signalling_table_value(table));
    }

    void onUnknownDescriptor(aribtlv::UnknownDescriptor&& descriptor) override {
        emit("onUnknownDescriptor", unknown_descriptor_value(descriptor));
    }

    void onSignallingMessage(aribtlv::SignallingMessage&& message) override {
        auto event = val::object();
        event.set("contextId", message.context_id);
        event.set("packetId", message.packet_id);
        event.set("messageId", message.message_id);
        event.set("data", copy_bytes(message.data));
        event.set("inputOffset", message.input_offset);
        emit("onSignallingMessage", event);
    }

    void onTrack(const aribtlv::TrackInfo& info) override {
        if (info.kind == aribtlv::TrackKind::Video) {
            video_track_ids_.insert(info.track_id);
            if (info.video && info.video->video_transfer_characteristics == 5) {
                hlg_video_track_ids_.insert(info.track_id);
            } else {
                hlg_video_track_ids_.erase(info.track_id);
            }
            mse_remuxer_.setVideoSignalling(info.track_id,
                tlvdemux::MseVideoSignalling{
                    info.video ? info.video->hdr_wcg_idc : std::nullopt,
                    info.video ? info.video->video_transfer_characteristics
                               : std::nullopt});
            const auto uhd_sdr = aribtlv::cicp_transfer_from_b60(3);
            if (info.video && info.video->video_transfer_characteristics.has_value() &&
                aribtlv::cicp_transfer_from_b60(
                    *info.video->video_transfer_characteristics) == uhd_sdr) {
                explicit_sdr_video_track_ids_.insert(info.track_id);
            } else {
                explicit_sdr_video_track_ids_.erase(info.track_id);
            }
            apply_video_presentation_policy(info.track_id);
        }
        auto event = track_info_value(info);
        if (info.audio.has_value()) {
            auto audio = val::object();
            audio.set("componentType", info.audio->component_type);
            audio.set("componentTag", info.audio->component_tag);
            audio.set("channelLayout", static_cast<unsigned>(info.audio->channel_layout));
            audio.set("channels", aribtlv::audio_channel_count(info.audio->channel_layout));
            audio.set("streamType", info.audio->stream_type);
            audio.set("simulcastGroupTag", info.audio->simulcast_group_tag);
            audio.set("multilingual", info.audio->es_multi_lingual);
            audio.set("sampleRate", info.audio->sample_rate);
            audio.set("mainComponent", info.audio->main_component);
            audio.set("secondaryLanguage", info.audio->secondary_language);
            event.set("audio", audio);
        }
        if (info.subtitle.has_value()) {
            auto subtitle = val::object();
            subtitle.set("tag", info.subtitle->tag);
            subtitle.set("infoVersion", info.subtitle->info_version);
            subtitle.set("type", info.subtitle->type);
            subtitle.set("format", info.subtitle->format);
            subtitle.set("operationMode", info.subtitle->operation_mode);
            subtitle.set("timingMode", info.subtitle->timing_mode);
            subtitle.set("displayMode", info.subtitle->display_mode);
            subtitle.set("resolution", info.subtitle->resolution);
            subtitle.set("compressionType", info.subtitle->compression_type);
            subtitle.set("startMpuSequenceNumber",
                         info.subtitle->start_mpu_sequence_number.has_value()
                             ? val(*info.subtitle->start_mpu_sequence_number)
                             : val::null());
            subtitle.set("referenceStartNtp",
                         info.subtitle->reference_start_ntp.has_value()
                             ? val(*info.subtitle->reference_start_ntp)
                             : val::null());
            subtitle.set("referenceStartTimeLeapIndicator",
                         info.subtitle->reference_start_time_leap_indicator);
            event.set("subtitle", subtitle);
        }
        emit("onTrack", event);
    }

    void onTrackRemoved(const aribtlv::TrackInfo& info) override {
        if (info.kind == aribtlv::TrackKind::Video) {
            video_track_ids_.erase(info.track_id);
            hlg_video_track_ids_.erase(info.track_id);
            explicit_sdr_video_track_ids_.erase(info.track_id);
        }
        emit("onTrackRemoved", track_info_value(info));
    }

    void onApplicationServiceRemoved(
        const aribtlv::ApplicationServiceInfo& info) override {
        auto event = val::object();
        event.set("contextId", info.context_id);
        event.set("applicationFormat", info.application_format);
        event.set("documentResolution", info.document_resolution);
        event.set("defaultAit", info.default_ait);
        event.set("hasDataTransmissionMessages",
                  info.has_data_transmission_messages);
        event.set("aitPacketId", info.ait_packet_id.has_value()
            ? val(*info.ait_packet_id) : val::null());
        event.set("dataTransmissionPacketId", info.data_transmission_packet_id.has_value()
            ? val(*info.data_transmission_packet_id) : val::null());
        emit("onApplicationServiceRemoved", event);
    }

    void onDataAssetRemoved(const aribtlv::DataAssetInfo& info) override {
        auto event = val::object();
        event.set("contextId", info.context_id);
        event.set("packetId", info.packet_id);
        event.set("componentTag", info.component_tag);
        event.set("assetType", info.asset_type);
        event.set("presentationRegions",
                  presentation_regions_value(info.presentation_regions));
        emit("onDataAssetRemoved", event);
    }

    void onApplicationRemoved(const aribtlv::ApplicationInfo& info) override {
        emit("onApplicationRemoved", application_info_value(info));
    }

    void onMptSnapshot(const aribtlv::MptSnapshot& snapshot) override {
        auto event = val::object();
        event.set("contextId", snapshot.context_id);
        event.set("sourcePacketId", snapshot.source_packet_id);
        event.set("packageId", copy_bytes(snapshot.package_id));
        event.set("version", snapshot.version);
        event.set("mode", snapshot.mode);
        event.set("inputOffset", snapshot.input_offset);
        auto tracks = val::array();
        for (std::size_t index = 0; index < snapshot.tracks.size(); ++index) {
            tracks.set(index, track_info_value(snapshot.tracks[index]));
        }
        event.set("tracks", tracks);
        auto services = val::array();
        for (std::size_t index = 0; index < snapshot.application_services.size(); ++index) {
            const auto& info = snapshot.application_services[index];
            auto service = val::object();
            service.set("contextId", info.context_id);
            service.set("applicationFormat", info.application_format);
            service.set("documentResolution", info.document_resolution);
            service.set("defaultAit", info.default_ait);
            service.set("hasDataTransmissionMessages",
                        info.has_data_transmission_messages);
            service.set("aitPacketId", info.ait_packet_id.has_value()
                ? val(*info.ait_packet_id) : val::null());
            service.set("dataTransmissionPacketId", info.data_transmission_packet_id.has_value()
                ? val(*info.data_transmission_packet_id) : val::null());
            services.set(index, service);
        }
        event.set("applicationServices", services);
        auto data_assets = val::array();
        for (std::size_t index = 0; index < snapshot.data_assets.size(); ++index) {
            const auto& info = snapshot.data_assets[index];
            auto asset = val::object();
            asset.set("contextId", info.context_id);
            asset.set("packetId", info.packet_id);
            asset.set("componentTag", info.component_tag);
            asset.set("assetType", info.asset_type);
            asset.set("presentationRegions", presentation_regions_value(info.presentation_regions));
            data_assets.set(index, asset);
        }
        event.set("dataAssets", data_assets);
        emit("onMptSnapshot", event);
    }

    void onMhAitSnapshot(const aribtlv::MhAitSnapshot& snapshot) override {
        auto event = val::object();
        event.set("contextId", snapshot.context_id);
        event.set("sourcePacketId", snapshot.source_packet_id);
        event.set("applicationType", snapshot.application_type);
        event.set("version", snapshot.version);
        event.set("currentNext", snapshot.current_next);
        event.set("inputOffset", snapshot.input_offset);
        auto applications = val::array();
        for (std::size_t index = 0; index < snapshot.applications.size(); ++index) {
            applications.set(index, application_info_value(snapshot.applications[index]));
        }
        event.set("applications", applications);
        emit("onMhAitSnapshot", event);
    }

    void onServiceStateReset(const aribtlv::ServiceStateReset& reset) override {
        auto event = val::object();
        event.set("contextId", reset.context_id.has_value()
            ? val(*reset.context_id) : val::null());
        event.set("reason", std::string(service_reset_reason_name(reset.reason)));
        emit("onServiceStateReset", event);
    }

    void onLayoutConfiguration(const aribtlv::LayoutConfiguration& info) override {
        emit("onLayoutConfiguration", layout_configuration_value(info));
    }

    void onAccessUnit(aribtlv::AccessUnit&& unit) override {
        if (index_active_) recording_index_.observe(unit);
        if (mse_enabled_) {
            const auto automatic = mse_remuxer_.push(unit);
            if (automatic) synchronizeAcceptedLayerSwitch(*automatic);
        }
        const bool valid_playback_timestamp =
            unit.codec == aribtlv::Codec::Ttml ||
            (unit.pts.timescale > 1 && unit.dts.timescale > 1);
        const bool playback_event = unit.codec == aribtlv::Codec::Ttml ||
            (unit.codec == aribtlv::Codec::Hevc &&
             (unit.random_access || unit.discontinuity)) ||
            (unit.codec == aribtlv::Codec::AacLatm && unit.discontinuity);
        if (has_callback("onPlaybackAccessUnitView") && playback_event &&
            valid_playback_timestamp) {
            const auto data = unit.codec == aribtlv::Codec::Ttml
                ? view_bytes(unit.data)
                : val::global("Uint8Array").new_(0);
            auto event = access_unit_event(unit, data);
            event.set("dataLifetime", std::string("callback"));
            emit("onPlaybackAccessUnitView", event);
        }
        if (mse_enabled_ && unit.codec == aribtlv::Codec::AacLatm &&
            selected_audio_track_.has_value() &&
            unit.track_id != *selected_audio_track_) return;
        if (has_callback("onAccessUnitView")) {
            auto event = access_unit_event(unit, view_bytes(unit.data));
            event.set("dataLifetime", std::string("callback"));
            emit("onAccessUnitView", event);
            return;
        }
        if (has_callback("onAccessUnit")) {
            emit("onAccessUnit", access_unit_event(unit, copy_bytes(unit.data)));
        }
    }

    void onApplication(const aribtlv::ApplicationInfo& info) override {
        application_events_.emplace_back(info);
    }

    void onDataDirectoryTable(const aribtlv::DataDirectoryTable& table) override {
        application_events_.emplace_back(table);
    }

    void onDataAssetManagementTable(const aribtlv::DataAssetManagementTable& table) override {
        application_events_.emplace_back(table);
    }

    void onDataUnit(aribtlv::DataUnit&& unit) override {
        application_events_.emplace_back(std::move(unit));
    }

    void onError(const aribtlv::Error& error) override {
        // Raw tuner streams can begin with null/filler bytes before the first
        // validated TLV packet. The parser already discards that prefix; do
        // not turn this expected startup resynchronization into an MSE error.
        if (is_initial_tlv_resynchronization(error)) return;
        auto event = val::object();
        event.set("code", std::string(error_code_name(error.code)));
        event.set("inputOffset", error.input_offset);
        event.set("recoverable", error.recoverable);
        event.set("message", error.message);
        emit("onError", event);
    }

    void onDamage(const aribtlv::DamageSpan& damage) override {
        const auto accepted = mse_remuxer_.observeDamage(damage);
        if (accepted) synchronizeAcceptedLayerSwitch(*accepted);
        if (!has_callback("onDamage")) return;
        auto event = val::object();
        event.set("trackId", damage.track_id);
        event.set("kind", std::string(track_kind_name(damage.kind)));
        event.set("codec", std::string(codec_name(damage.codec)));
        event.set("startPtsValue", damage.start_time.has_value()
            ? val(damage.start_time->value) : val::null());
        event.set("startPtsTimescale", damage.start_time.has_value()
            ? val(damage.start_time->timescale) : val::null());
        event.set("endPtsValue", damage.end_time.value);
        event.set("endPtsTimescale", damage.end_time.timescale);
        event.set("recoveryPtsValue", damage.recovery_time.has_value()
            ? val(damage.recovery_time->value) : val::null());
        event.set("recoveryPtsTimescale", damage.recovery_time.has_value()
            ? val(damage.recovery_time->timescale) : val::null());
        event.set("startInputOffset", damage.start_input_offset);
        event.set("endInputOffset", damage.end_input_offset);
        event.set("recoveryInputOffset", damage.recovery_input_offset);
        event.set("recoveryRestartOffset", damage.recovery_restart_offset);
        event.set("reasons", static_cast<std::uint32_t>(damage.reasons));
        event.set("recovered", damage.recovered);
        event.set("recoveryRandomAccess", damage.recovery_random_access);
        emit("onDamage", event);
    }

    void onBroadcastClock(const aribtlv::BroadcastClock& clock) override {
        emit("onBroadcastClock", broadcast_clock_value(clock));
    }

    void onEventInfo(const aribtlv::EventInfo& info) override {
        if (info.table_id == 0x8b && info.current_next && info.section_number == 0) {
            const auto hint = aribtlv::video_presentation_hint(info);
            if (presentation_policy_.set_programme_hint(hint)) {
                for (const auto track_id : video_track_ids_) {
                    apply_video_presentation_policy(track_id);
                }
            }
        }
        emit("onEventInfo", event_info_value(info));
    }

    void onMhSdtSnapshot(const aribtlv::MhSdtSnapshot& snapshot) override {
        emit("onMhSdtSnapshot", mh_sdt_value(snapshot));
    }

    void onMhTot(const aribtlv::MhTotInfo& info) override {
        emit("onMhTot", mh_tot_value(info));
    }

    void onStreamEvent(const aribtlv::StreamEvent& event) override {
        emit("onStreamEvent", stream_event_value(event));
    }

    void onViewerParticipationNotification(
        const aribtlv::ViewerParticipationNotification& notification) override {
        emit("onViewerParticipationNotification",
             viewer_participation_value(notification));
    }

    void onApplicationState(const aribtlv::ApplicationState& state) override {
        application_resources_.onApplicationState(state);
        emit("onApplicationState", application_state_event(state));
    }

    void onApplicationResource(aribtlv::ApplicationResource&& resource) override {
        const auto context_id = resource.context_id;
        const auto path = resource.path;
        application_resources_.onApplicationResource(std::move(resource));
        const auto stored = application_resources_.get(context_id, path);
        if (!stored) return;
        if (has_callback("onApplicationResourceView")) {
            auto event = application_resource_event(*stored, view_bytes(stored->data));
            event.set("dataLifetime", std::string("callback"));
            emit("onApplicationResourceView", event);
            return;
        }
        if (has_callback("onApplicationResource")) {
            emit("onApplicationResource",
                 application_resource_event(*stored, copy_bytes(stored->data)));
        }
    }

    void onApplicationResourceRemoved(
        const aribtlv::ApplicationResourceRemoval& removal) override {
        application_resources_.onApplicationResourceRemoved(removal);
        emit("onApplicationResourceRemoved", application_resource_removal_event(removal));
    }

    void onApplicationResourcesReset() override {
        application_resources_.onApplicationResourcesReset();
        emit("onApplicationResourcesReset", val::object());
    }

private:
    void apply_video_presentation_policy(const std::uint64_t track_id) {
        const auto decision = presentation_policy_.decision(
            explicit_sdr_video_track_ids_.count(track_id) != 0,
            hlg_video_track_ids_.count(track_id) != 0);
        mse_remuxer_.setSdrInHlg(track_id, decision.sdr_in_hlg);
        mse_remuxer_.setHlgSdrPrototype(track_id, decision.hlg_sdr_prototype);
    }

    static std::uint32_t mse_max_audio_channels(const val& options) {
        if (options.isNull() || options.isUndefined()) return 0;
        const auto value = options["mseMaxAudioChannels"];
        if (value.typeOf().as<std::string>() != "number") return 0;
        const auto channels = value.as<double>();
        if (!std::isfinite(channels) || channels <= 0 || channels > 24 ||
            std::floor(channels) != channels) return 0;
        return static_cast<std::uint32_t>(channels);
    }

    using ApplicationEvent = std::variant<aribtlv::ApplicationInfo,
                                          aribtlv::DataDirectoryTable,
                                          aribtlv::DataAssetManagementTable,
                                          aribtlv::DataUnit>;

    static aribtlv::Limits media_limits() {
        auto limits = aribtlv::Limits{};
        limits.collect_application_resources = false;
        return limits;
    }

    void reset_application_resources() {
        application_events_.clear();
        application_assembler_.reset();
    }

    void restart_application_assembly() {
        application_events_.clear();
        application_assembler_.dropTransientKeepActive();
    }

    void consume_application_event(aribtlv::ApplicationInfo info) {
        application_assembler_.onApplication(info);
    }
    void consume_application_event(aribtlv::DataDirectoryTable table) {
        application_assembler_.onDataDirectoryTable(table);
    }
    void consume_application_event(aribtlv::DataAssetManagementTable table) {
        application_assembler_.onDataAssetManagementTable(table);
    }
    void consume_application_event(aribtlv::DataUnit unit) {
        application_assembler_.onDataUnit(unit);
    }

    static val access_unit_event(const aribtlv::AccessUnit& unit, const val& data) {
        auto event = val::object();
        event.set("trackId", unit.track_id);
        event.set("codec", std::string(codec_name(unit.codec)));
        event.set("componentTag", unit.component_tag);
        event.set("subtitleTimingMode", unit.subtitle_timing_mode.has_value()
                                            ? val(*unit.subtitle_timing_mode)
                                            : val::null());
        // Per-access-unit subtitle metadata is temporarily unavailable in the
        // pinned libaribtlv revision. Track-level metadata remains available.
        event.set("subtitleOperationMode", val::null());
        event.set("subtitleDisplayMode", val::null());
        event.set("subtitleCompressionType", val::null());
        event.set("data", data);
        event.set("ptsValue", unit.pts.value);
        event.set("ptsTimescale", unit.pts.timescale);
        event.set("dtsValue", unit.dts.value);
        event.set("dtsTimescale", unit.dts.timescale);
        event.set("mpuSequenceNumber", unit.mpu_sequence_number.has_value()
                                           ? val(*unit.mpu_sequence_number)
                                           : val::null());
        if (unit.subtitle_reference_start_pts.has_value()) {
            event.set("subtitleReferenceStartPtsValue",
                      unit.subtitle_reference_start_pts->value);
            event.set("subtitleReferenceStartPtsTimescale",
                      unit.subtitle_reference_start_pts->timescale);
        } else {
            event.set("subtitleReferenceStartPtsValue", val::null());
            event.set("subtitleReferenceStartPtsTimescale", val::null());
        }
        auto resources = val::array();
        for (std::size_t index = 0; index < unit.subtitle_resources.size(); ++index) {
            const auto& source = unit.subtitle_resources[index];
            auto resource = val::object();
            resource.set("subsampleNumber", source.subsample_number);
            resource.set("dataType", source.data_type);
            // B62RendererStateMachine keeps a resource scope beyond this
            // callback, so resource payloads cannot borrow the AccessUnit.
            resource.set("data", copy_bytes(source.data));
            resources.set(index, resource);
        }
        event.set("subtitleResources", resources);
        event.set("restartOffset", unit.restart_offset);
        event.set("inputOffset", unit.input_offset);
        event.set("randomAccess", unit.random_access);
        event.set("discontinuity", unit.discontinuity);
        event.set("discontinuityReasons",
                  static_cast<std::uint32_t>(unit.discontinuity_reasons));
        return event;
    }

    static val application_resource_event(const aribtlv::ApplicationResource& resource,
                                          const val& data) {
        auto event = val::object();
        event.set("contextId", resource.context_id);
        event.set("componentTag", resource.component_tag);
        event.set("transactionId", resource.transaction_id);
        event.set("downloadId", resource.download_id);
        event.set("mpuSequenceNumber", resource.mpu_sequence_number);
        event.set("itemId", resource.item_id);
        event.set("version", resource.version);
        event.set("path", resource.path);
        event.set("contentType", resource.content_type);
        event.set("data", data);
        return event;
    }

    static val application_resource_removal_event(
        const aribtlv::ApplicationResourceRemoval& removal) {
        auto event = val::object();
        event.set("contextId", removal.context_id);
        event.set("componentTag", removal.component_tag);
        event.set("transactionId", removal.transaction_id);
        event.set("downloadId", removal.download_id);
        event.set("mpuSequenceNumber", removal.mpu_sequence_number);
        event.set("itemId", removal.item_id);
        event.set("path", removal.path);
        return event;
    }

    static val application_resource_metadata_event(
        const aribtlv::ApplicationResourceMetadata& resource) {
        auto event = val::object();
        event.set("contextId", resource.context_id);
        event.set("componentTag", resource.component_tag);
        event.set("transactionId", resource.transaction_id);
        event.set("downloadId", resource.download_id);
        event.set("mpuSequenceNumber", resource.mpu_sequence_number);
        event.set("itemId", resource.item_id);
        event.set("version", resource.version);
        event.set("path", resource.path);
        event.set("contentType", resource.content_type);
        event.set("size", resource.size);
        event.set("generation", resource.generation);
        return event;
    }

    static val application_state_event(const aribtlv::ApplicationState& state) {
        auto event = val::object();
        event.set("contextId", state.application.context_id);
        event.set("sourcePacketId", state.application.source_packet_id);
        event.set("applicationType", state.application.application_type);
        event.set("organizationId", state.application.organization_id);
        event.set("applicationId", state.application.application_id);
        event.set("controlCode", state.application.control_code);
        event.set("version", state.application.version);
        event.set("currentNext", state.application.current_next);
        event.set("sectionNumber", state.application.section_number);
        event.set("lastSectionNumber", state.application.last_section_number);
        event.set("inputOffset", state.application.input_offset);
        event.set("applicationDescriptorPresent",
                  state.application.application_descriptor_present);
        event.set("serviceBound", state.application.service_bound);
        event.set("visibility", state.application.visibility);
        event.set("presentApplicationPriority",
                  state.application.present_application_priority);
        event.set("applicationPriority", state.application.application_priority);
        auto profiles = val::array();
        for (std::size_t index = 0; index < state.application.profiles.size(); ++index) {
            const auto& profile = state.application.profiles[index];
            auto value = val::object();
            value.set("applicationProfile", profile.application_profile);
            value.set("versionMajor", profile.version_major);
            value.set("versionMinor", profile.version_minor);
            value.set("versionMicro", profile.version_micro);
            profiles.set(index, value);
        }
        event.set("profiles", profiles);
        auto labels = val::array();
        for (std::size_t index = 0;
             index < state.application.transport_protocol_labels.size(); ++index) {
            labels.set(index, state.application.transport_protocol_labels[index]);
        }
        event.set("transportProtocolLabels", labels);
        auto transports = val::array();
        for (std::size_t index = 0; index < state.application.transports.size(); ++index) {
            const auto& source = state.application.transports[index];
            auto transport = val::object();
            transport.set("protocolId", source.protocol_id);
            transport.set("label", source.label);
            auto transport_urls = val::array();
            for (std::size_t url_index = 0; url_index < source.urls.size(); ++url_index) {
                transport_urls.set(url_index, source.urls[url_index]);
            }
            transport.set("urls", transport_urls);
            transports.set(index, transport);
        }
        event.set("transports", transports);
        event.set("entryPath", state.application.entry_path);
        auto urls = val::array();
        for (std::size_t index = 0;
             index < state.application.transport_urls.size(); ++index) {
            urls.set(index, state.application.transport_urls[index]);
        }
        event.set("transportUrls", urls);
        event.set("state", std::string(application_collection_state_name(state.state)));
        event.set("lifecycle",
                  std::string(application_lifecycle_state_name(state.lifecycle)));
        event.set("entryReady", state.entry_ready);
        event.set("resourceCount", state.resource_count);
        return event;
    }

    bool has_callback(const char* name) const {
        if (callbacks_.isNull() || callbacks_.isUndefined()) return false;
        return callbacks_[name].typeOf().as<std::string>() == "function";
    }

    template <typename T>
    static std::optional<T> optional_number(const val& value) {
        if (value.isNull() || value.isUndefined()) return std::nullopt;
        return value.as<T>();
    }

    void emit(const char* name, const val& event) {
        if (!has_callback(name)) return;
        const auto callback = callbacks_[name];
        callback.call<void>("call", callbacks_, event);
    }

    void emit_mse_output_state() {
        if (!has_callback("onMseOutputState")) return;
        const auto& state = output_state_.state();
        auto event = val::object();
        event.set("generation", state.generation);
        event.set("connected", state.connected);
        event.set("hdrMode", static_cast<std::uint8_t>(state.hdr_mode));
        event.set("edidValid", state.capabilities.edid_valid);
        event.set("hdrSupport", state.capabilities.hdr_support);
        event.set("pqEotf", state.capabilities.pq_eotf);
        event.set("hlgEotf", state.capabilities.hlg_eotf);
        event.set("bt2020", state.capabilities.bt2020);
        event.set("supports4k50_60", state.capabilities.supports_4k50_60);
        event.set("colorSpaceMask", state.capabilities.color_space_mask);
        event.set("maxDeepColorBits", state.capabilities.max_deep_color_bits);
        event.set("maxTmdsClockMhz", state.capabilities.max_tmds_clock_mhz);
        event.set("dolbyTunnelSupported", state.dolby_tunnel.tunnel_supported);
        event.set("dolbyMetadataPassthrough", state.dolby_tunnel.metadata_passthrough);
        event.set("dolbyObservedProfile", state.dolby_tunnel.observed_profile.has_value()
            ? val(*state.dolby_tunnel.observed_profile) : val::null());
        emit("onMseOutputState", event);
    }

    void restoreLayerSelection(
        const std::optional<tlvdemux::MseLayerSwitchCancelled>& cancelled) {
        if (!cancelled) return;
        restoreLayerSelectionState(*cancelled);
        demuxer_.selectTrack(aribtlv::TrackKind::Video, std::nullopt);
    }

    void restoreLayerSelectionState(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) {
        selected_video_track_ = cancelled.previous_video_track_id == 0
            ? std::nullopt
            : std::optional<std::uint64_t>{cancelled.previous_video_track_id};
        selected_audio_track_ = cancelled.previous_audio_track_id == 0
            ? std::nullopt
            : std::optional<std::uint64_t>{cancelled.previous_audio_track_id};
        if (index_active_ && recording_index_.state() == aribtlv::IndexState::Building) {
            recording_index_.selectVideoTrack(selected_video_track_);
        }
    }

    val callbacks_;
    aribtlv::ApplicationResourceAssembler application_assembler_;
    std::deque<ApplicationEvent> application_events_;
    aribtlv::Demuxer demuxer_;
    aribtlv::ApplicationResourceStore application_resources_;
    WasmMseRemuxer mse_remuxer_;
    aribtlv::RecordingIndex recording_index_;
    bool index_active_ = false;
    bool index_growing_ = false;
    bool mse_enabled_ = false;
    std::optional<std::uint64_t> selected_video_track_;
    std::optional<std::uint64_t> selected_audio_track_;
    std::set<std::uint64_t> video_track_ids_;
    std::set<std::uint64_t> hlg_video_track_ids_;
    std::set<std::uint64_t> explicit_sdr_video_track_ids_;
    PresentationPolicy presentation_policy_;
    tlvdemux::MseOutputStateTracker output_state_;
};
