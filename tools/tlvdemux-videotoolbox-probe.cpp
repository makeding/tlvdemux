#include <aribtlv/demuxer.hpp>
#include <tlvdemux/mse_remuxer.hpp>

#include "recording_time_seek.hpp"
#include "mac_display_hdr.hpp"
#include "mse/chromium_coded_frame_policy.hpp"
#include "videotoolbox_probe_parsing.hpp"
#include "videotoolbox_probe.hpp"

#include <CoreMedia/CoreMedia.h>
#include <VideoToolbox/VideoToolbox.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace tlvdemux::tools::vt_probe;

class Probe final : public aribtlv::Sink, public tlvdemux::MseSink {
public:
    explicit Probe(const Options& options)
        : wanted_video_packet_id_(options.video_packet_id),
          wanted_audio_packet_id_(options.audio_packet_id),
          wanted_fallback_video_packet_id_(options.fallback_video_packet_id),
          wanted_fallback_audio_packet_id_(options.fallback_audio_packet_id),
          maximum_access_units_(options.maximum_access_units),
          skip_leading_rasl_(options.skip_leading_rasl),
          playback_rate_(options.playback_rate),
          inflight_frames_(options.inflight_frames),
          prepend_parameter_sets_on_irap_(options.prepend_parameter_sets_on_irap),
          mse_pipeline_(options.mse_pipeline), timeline_only_(options.timeline_only),
          require_hardware_(options.require_hardware),
          mse_remuxer_(*this) {}

    ~Probe() override {
        finish();
        if (session_ != nullptr) CFRelease(session_);
        if (format_ != nullptr) CFRelease(format_);
    }

    void onService(const aribtlv::ServiceInfo&) override {}

    void onTrack(const aribtlv::TrackInfo& track) override {
        if (track.kind == aribtlv::TrackKind::Video &&
            track.codec == aribtlv::Codec::Hevc) {
            if (!video_track_.has_value() &&
                (!wanted_video_packet_id_ || track.packet_id == *wanted_video_packet_id_)) {
                video_track_ = track.track_id;
                if (mse_pipeline_) {
                    mse_remuxer_.selectTrack(aribtlv::TrackKind::Video, track.track_id);
                }
            }
            if (wanted_fallback_video_packet_id_ &&
                track.packet_id == *wanted_fallback_video_packet_id_) {
                fallback_video_track_ = track.track_id;
            }
            std::cerr << "video track packet_id=0x" << std::hex << track.packet_id << std::dec
                      << " timescale=" << track.timescale;
            if (track.video.has_value()) {
                std::cerr << " hdr_wcg_idc=";
                if (track.video->hdr_wcg_idc.has_value()) {
                    std::cerr << unsigned(*track.video->hdr_wcg_idc);
                } else {
                    std::cerr << "missing";
                }
                std::cerr << " video_transfer_characteristics=";
                if (track.video->video_transfer_characteristics.has_value()) {
                    std::cerr << unsigned(*track.video->video_transfer_characteristics);
                } else {
                    std::cerr << "missing";
                }
            }
            std::cerr << '\n';
        } else if (mse_pipeline_ && track.kind == aribtlv::TrackKind::Audio &&
                   track.audio.has_value() &&
                   aribtlv::audio_channel_count(track.audio->channel_layout) <= 6) {
            if (!audio_track_.has_value() &&
                (!wanted_audio_packet_id_.has_value() ||
                 track.packet_id == *wanted_audio_packet_id_)) {
                audio_track_ = track.track_id;
                mse_remuxer_.selectTrack(aribtlv::TrackKind::Audio, track.track_id);
            }
            if (wanted_fallback_audio_packet_id_ &&
                track.packet_id == *wanted_fallback_audio_packet_id_) {
                fallback_audio_track_ = track.track_id;
            }
            std::cerr << "audio track packet_id=0x" << std::hex << track.packet_id << std::dec
                      << " timescale=" << track.timescale << '\n';
        }
        configure_automatic_layer_switch();
    }

    void onAccessUnit(aribtlv::AccessUnit&& unit) override {
        if (done_) return;
        if (unit.codec == aribtlv::Codec::Hevc && unit.discontinuity) {
            std::cerr << "video discontinuity pts=" << seconds(unit.pts)
                      << " dts=" << seconds(unit.dts)
                      << " rap=" << (unit.random_access ? 1 : 0)
                      << " input_offset=" << unit.input_offset << '\n';
        }

        if (mse_pipeline_ && (unit.codec == aribtlv::Codec::Hevc ||
                             unit.codec == aribtlv::Codec::AacLatm)) {
            const auto request = mse_remuxer_.push(unit);
            if (request.has_value()) {
                std::cerr << "automatic layer request video=" << request->video_track_id
                          << " audio=" << request->audio_track_id
                          << " earliest=" << request->earliest_presentation_time_us << '\n';
                if (!mse_remuxer_.switchLayer(
                        request->video_track_id, request->audio_track_id,
                        request->earliest_presentation_time_us)) {
                    fail_pipeline("automatic layer switch request was rejected");
                }
            }
            return;
        }
        if (!video_track_.has_value() || unit.track_id != *video_track_ ||
            unit.codec != aribtlv::Codec::Hevc) return;

        const auto nals = split_annex_b(unit.data);
        remember_parameter_sets(nals);
        if (session_ == nullptr && !create_session()) return;

        const bool has_vcl = std::any_of(nals.begin(), nals.end(),
                                         [](const auto& nal) { return nal.type <= 31; });
        const bool has_irap = std::any_of(nals.begin(), nals.end(),
                                          [](const auto& nal) {
                                              return nal.type >= 16 && nal.type <= 23;
                                          });
        const bool only_rasl_vcl = has_vcl && std::all_of(
            nals.begin(), nals.end(), [](const auto& nal) {
                return nal.type > 31 || nal.type == 8 || nal.type == 9;
            });
        if (skip_leading_rasl_ && waiting_for_first_trailing_picture_ && only_rasl_vcl) {
            std::cerr << "skip leading RASL pts=" << seconds(unit.pts)
                      << " dts=" << seconds(unit.dts)
                      << " nal=" << nal_types(nals) << '\n';
            return;
        }
        if (waiting_for_first_trailing_picture_ && has_vcl && !has_irap) {
            waiting_for_first_trailing_picture_ = false;
        }

        pace(unit.dts);

        ++access_unit_count_;
        const auto status = decode(unit, nals);
        std::cerr << "au=" << access_unit_count_
                  << " pts=" << seconds(unit.pts)
                  << " dts=" << seconds(unit.dts)
                  << " rap=" << (unit.random_access ? 1 : 0)
                  << " nal=" << nal_types(nals)
                  << " submit=" << status << '\n';
        if (status != noErr || callback_status_.load() != noErr ||
            access_unit_count_ >= maximum_access_units_) {
            done_ = true;
        }
        if (access_unit_count_ == 1 && has_irap) waiting_for_first_trailing_picture_ = true;
    }

    void onError(const aribtlv::Error& error) override {
        if (error.code == aribtlv::ErrorCode::Discontinuity) {
            std::cerr << "demux discontinuity @" << error.input_offset
                      << ": " << error.message << '\n';
        }
        if (!error.recoverable) {
            std::cerr << "demux error @" << error.input_offset << ": " << error.message << '\n';
            pipeline_ok_ = false;
            done_ = true;
        }
    }

    void onMseInit(tlvdemux::MseTrackInit&& init) override {
        if (init.type == "audio") {
            audio_timescale_ = init.sample_rate;
            chromium_audio_policy_.reset();
            std::cerr << "mse init " << init.mime << " sample_rate=" << init.sample_rate
                      << " channels=" << init.channels << '\n';
            return;
        }
        if (init.type != "video") return;
        chromium_video_policy_.reset();
        const auto mdhd = find_box_signature(init.data, "mdhd");
        if (!mdhd || mdhd->payload + 16 > mdhd->offset + mdhd->size) {
            fail_pipeline("video init segment has no valid mdhd");
            return;
        }
        video_timescale_ = be32(init.data.data() + mdhd->payload + 12);
        if (video_timescale_ == 0) {
            fail_pipeline("video init segment has a zero timescale");
            return;
        }
        const auto hvcc = find_box_signature(init.data, "hvcC");
        if (!hvcc || hvcc->payload + 23 > hvcc->offset + hvcc->size) {
            fail_pipeline("video init segment has no valid hvcC");
            return;
        }
        const auto* payload = init.data.data() + hvcc->payload;
        const auto payload_size = hvcc->size - (hvcc->payload - hvcc->offset);
        mse_nal_length_size_ = static_cast<std::uint8_t>((payload[21] & 3U) + 1U);
        const auto array_count = payload[22];
        std::size_t offset = 23;
        std::array<std::vector<std::uint8_t>, 3> parsed_parameter_sets;
        for (std::uint8_t array_index = 0; array_index < array_count; ++array_index) {
            if (offset + 3 > payload_size) {
                fail_pipeline("truncated hvcC array header");
                return;
            }
            const auto type = static_cast<std::uint8_t>(payload[offset++] & 0x3fU);
            const auto count = static_cast<std::uint16_t>(
                (std::uint16_t(payload[offset]) << 8U) | payload[offset + 1]);
            offset += 2;
            for (std::uint16_t index = 0; index < count; ++index) {
                if (offset + 2 > payload_size) {
                    fail_pipeline("truncated hvcC NAL length");
                    return;
                }
                const auto size = static_cast<std::uint16_t>(
                    (std::uint16_t(payload[offset]) << 8U) | payload[offset + 1]);
                offset += 2;
                if (size < 2 || offset + size > payload_size) {
                    fail_pipeline("invalid hvcC NAL payload");
                    return;
                }
                if (type >= 32 && type <= 34 && parsed_parameter_sets[type - 32].empty()) {
                    parsed_parameter_sets[type - 32].assign(payload + offset,
                                                             payload + offset + size);
                }
                offset += size;
            }
        }
        if (std::any_of(parsed_parameter_sets.begin(), parsed_parameter_sets.end(),
                        [](const auto& value) { return value.empty(); })) {
            fail_pipeline("hvcC does not contain VPS/SPS/PPS");
            return;
        }
        reset_decoder();
        parameter_sets_ = parsed_parameter_sets;
        mse_config_parameter_sets_ = std::move(parsed_parameter_sets);
        std::cerr << "mse init " << init.mime << " length_size="
                  << unsigned(mse_nal_length_size_) << " size=" << init.width << 'x'
                  << init.height;
        const auto colr = find_box_signature(init.data, "colr");
        if (colr && colr->payload + 11 <= colr->offset + colr->size &&
            std::equal(init.data.begin() + static_cast<std::ptrdiff_t>(colr->payload),
                       init.data.begin() + static_cast<std::ptrdiff_t>(colr->payload + 4),
                       "nclx")) {
            const auto* color = init.data.data() + colr->payload + 4;
            std::cerr << " nclx=" << be16(color) << '/' << be16(color + 2) << '/'
                      << be16(color + 4) << " full_range="
                      << ((color[6] & 0x80U) != 0 ? 1 : 0);
        } else {
            std::cerr << " nclx=missing";
        }
        std::cerr << '\n';
    }

    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        if (done_) return;
        try {
            if (segment.type == "video") decode_mse_segment(segment.data);
            else if (segment.type == "audio") validate_audio_mse_segment(segment.data);
        } catch (const std::exception& error) {
            fail_pipeline(error.what());
        }
    }

    void onMseVideoStart(const tlvdemux::MseVideoStart& start) override {
        std::cerr << "mse video start nal=" << start.nal_type
                  << " signalled_rap=" << (start.signalled_random_access ? 1 : 0) << '\n';
    }

    void onMseLayerSwitch(const tlvdemux::MseLayerSwitch& layer) override {
        layer_switch_completed_ = true;
        std::cerr << "mse layer switch video=" << layer.video_track_id
                  << " audio=" << layer.audio_track_id
                  << " video_pts=" << layer.video_presentation_time_us
                  << " audio_pts=" << layer.audio_presentation_time_us << '\n';
    }

    void onMseLayerSwitchCancelled(
        const tlvdemux::MseLayerSwitchCancelled& cancelled) override {
        std::cerr << "mse layer switch cancelled video=" << cancelled.video_track_id
                  << " audio=" << cancelled.audio_track_id
                  << " reason=" << static_cast<int>(cancelled.reason) << '\n';
    }

    void onMseVideoSplice(const tlvdemux::MseVideoSplice& splice) override {
        std::cerr << "mse video splice pts=" << splice.presentation_time_us << '\n';
        // MSE removes the old presentation-time tail before appending the new
        // coded frame group. HEVC decode timestamps may legitimately begin
        // before this PTS because of reordered leading pictures, so there is
        // no cross-splice DTS lower bound to preserve here.
        previous_mse_decode_end_.reset();
    }

    void onMseAudioSplice(const tlvdemux::MseAudioSplice& splice) override {
        if (audio_timescale_ != 0) {
            previous_audio_decode_end_ = scale_from_us(
                splice.presentation_time_us, audio_timescale_);
        }
    }

    bool done() const { return done_; }
    bool ok() const {
        return pipeline_ok_ && callback_status_.load() == noErr &&
            (!automatic_layer_configured_ || layer_switch_completed_) &&
            (timeline_only_ ? access_unit_count_ != 0 : decoded_count_.load() != 0);
    }
    OSStatus callback_status() const { return callback_status_.load(); }
    std::size_t decoded_count() const { return decoded_count_.load(); }
    std::size_t timeline_gap_count() const { return timeline_gap_count_; }
    std::uint64_t largest_timeline_gap_us() const { return largest_timeline_gap_us_; }
    std::size_t audio_sample_count() const { return audio_sample_count_; }
    std::size_t audio_timeline_gap_count() const { return audio_timeline_gap_count_; }
    std::uint64_t largest_audio_timeline_gap() const { return largest_audio_timeline_gap_; }
    std::size_t mse_pps_sample_count() const { return mse_pps_sample_count_; }
    std::size_t mse_pps_variant_count() const { return mse_pps_variants_.size(); }

    void finish() {
        if (mse_pipeline_ && !mse_flushed_) {
            mse_flushed_ = true;
            mse_remuxer_.endOfStream();
        }
        if (session_ != nullptr) VTDecompressionSessionWaitForAsynchronousFrames(session_);
    }

private:
    static std::uint64_t scale_from_us(const std::int64_t value,
                                       const std::uint32_t timescale) {
        return static_cast<std::uint64_t>(std::llround(
            static_cast<double>(value) * timescale / 1000000.0));
    }

    static std::uint64_t scale_to_us(const std::uint64_t value,
                                     const std::uint32_t timescale) {
        return static_cast<std::uint64_t>(std::llround(
            static_cast<double>(value) * 1000000.0 / timescale));
    }

    void configure_automatic_layer_switch() {
        if (automatic_layer_configured_ || !video_track_ || !audio_track_ ||
            !fallback_video_track_ || !fallback_audio_track_) return;
        mse_remuxer_.configureAutomaticLayerSwitch({
            *video_track_, *audio_track_, *fallback_video_track_, *fallback_audio_track_});
        automatic_layer_configured_ = true;
        std::cerr << "automatic layer pair video=" << *video_track_ << '/' 
                  << *fallback_video_track_ << " audio=" << *audio_track_ << '/'
                  << *fallback_audio_track_ << '\n';
    }

    static double seconds(const aribtlv::Timestamp timestamp) {
        if (timestamp.timescale == 0) return 0.0;
        return static_cast<double>(timestamp.value) / static_cast<double>(timestamp.timescale);
    }

    void remember_parameter_sets(const std::vector<NalUnit>& nals) {
        for (const auto& nal : nals) {
            if (nal.type < 32 || nal.type > 34) continue;
            auto& target = parameter_sets_[nal.type - 32];
            target.assign(nal.data, nal.data + nal.size);
        }
    }

    void pace(const aribtlv::Timestamp dts) {
        if (playback_rate_ <= 0.0 || dts.timescale == 0) return;
        pace_seconds(seconds(dts));
    }

    void pace_seconds(const double value) {
        if (playback_rate_ <= 0.0) return;
        if (!first_dts_seconds_.has_value()) {
            first_dts_seconds_ = value;
            pacing_started_ = std::chrono::steady_clock::now();
            return;
        }
        const auto media_seconds = value - *first_dts_seconds_;
        if (media_seconds <= 0.0) return;
        const auto target = pacing_started_ + std::chrono::duration_cast<
            std::chrono::steady_clock::duration>(
                std::chrono::duration<double>(media_seconds / playback_rate_));
        std::this_thread::sleep_until(target);
    }

    void fail_pipeline(const std::string& message) {
        pipeline_ok_ = false;
        done_ = true;
        std::cerr << "mse pipeline error: " << message << '\n';
    }

    void reset_decoder() {
        if (session_ != nullptr) {
            VTDecompressionSessionWaitForAsynchronousFrames(session_);
            VTDecompressionSessionInvalidate(session_);
            CFRelease(session_);
            session_ = nullptr;
        }
        if (format_ != nullptr) {
            CFRelease(format_);
            format_ = nullptr;
        }
        frames_since_wait_ = 0;
        decoder_parameter_sets_ = {};
    }

    bool create_session() {
        for (const auto& parameter_set : parameter_sets_) {
            if (parameter_set.empty()) return false;
        }
        std::array<const std::uint8_t*, 3> pointers{};
        std::array<std::size_t, 3> sizes{};
        for (std::size_t index = 0; index < parameter_sets_.size(); ++index) {
            pointers[index] = parameter_sets_[index].data();
            sizes[index] = parameter_sets_[index].size();
        }
        auto status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(
            kCFAllocatorDefault, pointers.size(), pointers.data(), sizes.data(), 4, nullptr,
            &format_);
        if (status != noErr) {
            std::cerr << "CMVideoFormatDescriptionCreateFromHEVCParameterSets: " << status << '\n';
            done_ = true;
            return false;
        }
        decoder_parameter_sets_ = parameter_sets_;

        std::cerr << "CMFormatDescription color primaries="
                  << cf_description(CMFormatDescriptionGetExtension(
                         format_, kCMFormatDescriptionExtension_ColorPrimaries))
                  << " transfer="
                  << cf_description(CMFormatDescriptionGetExtension(
                         format_, kCMFormatDescriptionExtension_TransferFunction))
                  << " matrix="
                  << cf_description(CMFormatDescriptionGetExtension(
                         format_, kCMFormatDescriptionExtension_YCbCrMatrix))
                  << " full_range="
                  << cf_description(CMFormatDescriptionGetExtension(
                         format_, kCMFormatDescriptionExtension_FullRangeVideo)) << '\n';

        CFDictionaryRef decoder_specification = nullptr;
        if (require_hardware_) {
            const void* decoder_keys[] = {
                kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder,
            };
            const void* decoder_values[] = {kCFBooleanTrue};
            decoder_specification = CFDictionaryCreate(
                kCFAllocatorDefault, decoder_keys, decoder_values, 1,
                &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        }
        VTDecompressionOutputCallbackRecord callback{&Probe::output_callback, this};
        status = VTDecompressionSessionCreate(kCFAllocatorDefault, format_,
                                               decoder_specification, nullptr,
                                               &callback, &session_);
        if (decoder_specification != nullptr) CFRelease(decoder_specification);
        if (status != noErr) {
            std::cerr << "VTDecompressionSessionCreate: " << status << '\n';
            done_ = true;
            return false;
        }
        CFTypeRef hardware_value = nullptr;
        const auto property_status = VTSessionCopyProperty(
            session_, kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
            kCFAllocatorDefault, &hardware_value);
        const bool hardware = property_status == noErr && hardware_value == kCFBooleanTrue;
        if (hardware_value != nullptr) CFRelease(hardware_value);
        std::cerr << "VideoToolbox session created (hardware="
                  << (hardware ? "yes" : "unknown") << ")\n";
        return true;
    }

    static bool append_nal(std::vector<std::uint8_t>& sample, const std::uint8_t* data,
                           const std::size_t nal_size) {
        if (nal_size > std::numeric_limits<std::uint32_t>::max()) return false;
        const auto size = static_cast<std::uint32_t>(nal_size);
        sample.push_back(static_cast<std::uint8_t>(size >> 24U));
        sample.push_back(static_cast<std::uint8_t>(size >> 16U));
        sample.push_back(static_cast<std::uint8_t>(size >> 8U));
        sample.push_back(static_cast<std::uint8_t>(size));
        sample.insert(sample.end(), data, data + nal_size);
        return true;
    }

    OSStatus submit_sample(const std::vector<std::uint8_t>& sample, const CMTime pts,
                           const CMTime dts, const bool random_access) {
        if (sample.empty() || session_ == nullptr || format_ == nullptr) return paramErr;
        CMBlockBufferRef block = nullptr;
        auto status = CMBlockBufferCreateWithMemoryBlock(
            kCFAllocatorDefault, nullptr, sample.size(), kCFAllocatorDefault, nullptr, 0,
            sample.size(), 0, &block);
        if (status != noErr) return status;
        status = CMBlockBufferReplaceDataBytes(sample.data(), block, 0, sample.size());
        if (status != noErr) {
            CFRelease(block);
            return status;
        }

        const CMSampleTimingInfo timing{kCMTimeInvalid, pts, dts};
        const auto sample_size = sample.size();
        CMSampleBufferRef buffer = nullptr;
        status = CMSampleBufferCreateReady(kCFAllocatorDefault, block, format_, 1, 1, &timing,
                                           1, &sample_size, &buffer);
        CFRelease(block);
        if (status != noErr) return status;

        if (!random_access) {
            const auto attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, true);
            if (attachments != nullptr && CFArrayGetCount(attachments) != 0) {
                auto dictionary = reinterpret_cast<CFMutableDictionaryRef>(
                    const_cast<void*>(CFArrayGetValueAtIndex(attachments, 0)));
                CFDictionarySetValue(dictionary, kCMSampleAttachmentKey_NotSync,
                                     kCFBooleanTrue);
            }
        }

        VTDecodeInfoFlags flags = 0;
        status = VTDecompressionSessionDecodeFrame(
            session_, buffer, kVTDecodeFrame_EnableAsynchronousDecompression, nullptr, &flags);
        CFRelease(buffer);
        if (status == noErr) {
            ++frames_since_wait_;
            if (frames_since_wait_ >= inflight_frames_) {
                status = VTDecompressionSessionWaitForAsynchronousFrames(session_);
                frames_since_wait_ = 0;
            }
        }
        return status;
    }

    OSStatus decode(const aribtlv::AccessUnit& unit, const std::vector<NalUnit>& nals) {
        std::vector<std::uint8_t> sample;
        const bool has_irap = std::any_of(nals.begin(), nals.end(), [](const auto& nal) {
            return nal.type >= 16 && nal.type <= 23;
        });
        std::size_t first_original = 0;
        if (prepend_parameter_sets_on_irap_ && has_irap) {
            // Make the hvcC parameter sets available at the random-access
            // sample while retaining any in-band updates in the access unit.
            if (!nals.empty() && nals.front().type == 35) {
                if (!append_nal(sample, nals.front().data, nals.front().size)) return paramErr;
                first_original = 1;
            }
            for (const auto& parameter_set : decoder_parameter_sets_) {
                if (!append_nal(sample, parameter_set.data(), parameter_set.size())) return paramErr;
            }
        }
        for (std::size_t index = first_original; index < nals.size(); ++index) {
            const auto& nal = nals[index];
            if (nal.size > std::numeric_limits<std::uint32_t>::max()) return paramErr;
            if (!append_nal(sample, nal.data, nal.size)) return paramErr;
        }
        return submit_sample(
            sample,
            CMTimeMake(unit.pts.value, static_cast<std::int32_t>(unit.pts.timescale)),
            CMTimeMake(unit.dts.value, static_cast<std::int32_t>(unit.dts.timescale)),
            unit.random_access);
    }

    void decode_mse_segment(const std::vector<std::uint8_t>& data) {
        const auto top = child_boxes(data, 0, data.size());
        const auto moof = box_of_type(top, "moof");
        const auto mdat = box_of_type(top, "mdat");
        if (!moof || !mdat) throw std::runtime_error("media segment requires moof and mdat");
        const auto moof_children = child_boxes(data, moof->payload,
                                               moof->offset + moof->size);
        const auto traf = box_of_type(moof_children, "traf");
        if (!traf) throw std::runtime_error("moof has no traf");
        const auto traf_children = child_boxes(data, traf->payload,
                                               traf->offset + traf->size);
        const auto tfdt = box_of_type(traf_children, "tfdt");
        const auto trun = box_of_type(traf_children, "trun");
        if (!tfdt || !trun) throw std::runtime_error("traf requires tfdt and trun");
        if (tfdt->payload + 8 > tfdt->offset + tfdt->size ||
            trun->payload + 12 > trun->offset + trun->size) {
            throw std::runtime_error("truncated tfdt/trun");
        }

        const auto tfdt_version = data[tfdt->payload];
        const auto tfdt_data = tfdt->payload + 4;
        std::uint64_t decode_time = 0;
        if (tfdt_version == 1) {
            if (tfdt_data + 8 > tfdt->offset + tfdt->size)
                throw std::runtime_error("truncated 64-bit tfdt");
            decode_time = be64(data.data() + tfdt_data);
        } else if (tfdt_version == 0) {
            if (tfdt_data + 4 > tfdt->offset + tfdt->size)
                throw std::runtime_error("truncated 32-bit tfdt");
            decode_time = be32(data.data() + tfdt_data);
        } else {
            throw std::runtime_error("unsupported tfdt version");
        }

        const auto trun_version = data[trun->payload];
        const auto trun_flags = (std::uint32_t(data[trun->payload + 1]) << 16U) |
                                (std::uint32_t(data[trun->payload + 2]) << 8U) |
                                std::uint32_t(data[trun->payload + 3]);
        constexpr std::uint32_t required_flags = 0x000f01;
        if ((trun_flags & required_flags) != required_flags)
            throw std::runtime_error("trun lacks per-sample duration/size/flags/cto");
        const auto sample_count = be32(data.data() + trun->payload + 4);
        const auto signed_data_offset = static_cast<std::int32_t>(
            be32(data.data() + trun->payload + 8));
        const auto payload_position_signed = static_cast<std::int64_t>(moof->offset) +
                                             signed_data_offset;
        if (payload_position_signed < 0)
            throw std::runtime_error("negative trun data offset");
        auto payload_position = static_cast<std::size_t>(payload_position_signed);
        if (payload_position < mdat->payload || payload_position > mdat->offset + mdat->size)
            throw std::runtime_error("trun data offset does not point into mdat");

        auto entry = trun->payload + 12;
        std::uint64_t dts = decode_time;
        if (previous_mse_decode_end_.has_value() && dts < *previous_mse_decode_end_) {
            throw std::runtime_error(
                "MSE decode timeline overlap: tfdt=" + std::to_string(dts) +
                " previous_end=" + std::to_string(*previous_mse_decode_end_));
        }
        if (previous_mse_decode_end_.has_value() && dts > *previous_mse_decode_end_) {
            const auto gap = dts - *previous_mse_decode_end_;
            ++timeline_gap_count_;
            const auto gap_us = scale_to_us(gap, video_timescale_);
            largest_timeline_gap_us_ = std::max(largest_timeline_gap_us_, gap_us);
            std::cerr << "mse timeline gap fragment=" << (mse_fragment_count_ + 1)
                      << " previous_end="
                      << (static_cast<double>(*previous_mse_decode_end_) / video_timescale_)
                      << " next_dts=" << (static_cast<double>(dts) / video_timescale_)
                      << " gap=" << (static_cast<double>(gap) / video_timescale_) << '\n';
        }
        ++mse_fragment_count_;
        for (std::uint32_t sample_index = 0; sample_index < sample_count; ++sample_index) {
            if (entry + 16 > trun->offset + trun->size)
                throw std::runtime_error("truncated trun sample table");
            const auto duration = be32(data.data() + entry);
            const auto size = be32(data.data() + entry + 4);
            const auto flags = be32(data.data() + entry + 8);
            const auto cto_bits = be32(data.data() + entry + 12);
            const auto composition_offset = trun_version == 1
                ? static_cast<std::int64_t>(static_cast<std::int32_t>(cto_bits))
                : static_cast<std::int64_t>(cto_bits);
            entry += 16;
            if (duration == 0) throw std::runtime_error("zero-duration video sample");
            if (size == 0 || size > data.size() - payload_position)
                throw std::runtime_error("invalid mdat sample size");
            const auto nals = split_length_prefixed(data.data() + payload_position, size,
                                                     mse_nal_length_size_);
            if (nals.empty()) throw std::runtime_error("invalid length-prefixed HEVC sample");
            bool has_inband_pps = false;
            for (const auto& nal : nals) {
                if (nal.type != 34) continue;
                has_inband_pps = true;
                const bool inserted =
                    mse_pps_variants_.emplace(nal.data, nal.data + nal.size).second;
                if (inserted) {
                    std::cerr << "mse pps variant=" << mse_pps_variants_.size()
                              << " first_dts="
                              << (static_cast<double>(dts) / video_timescale_)
                              << " size=" << nal.size << '\n';
                }
            }
            if (has_inband_pps) ++mse_pps_sample_count_;

            const bool metadata_sync = (flags & 0x00010000U) == 0;
            const auto depends_on = static_cast<std::uint8_t>((flags >> 24U) & 3U);
            const bool metadata_keyframe = metadata_sync && depends_on != 1;
            const bool bitstream_keyframe = std::any_of(nals.begin(), nals.end(),
                [](const auto& nal) { return nal.type >= 16 && nal.type <= 23; });
            if (metadata_keyframe != bitstream_keyframe) {
                std::cerr << "mse keyframe mismatch fragment=" << mse_fragment_count_
                          << " sample=" << sample_index
                          << " metadata=" << (metadata_keyframe ? 1 : 0)
                          << " bitstream=" << (bitstream_keyframe ? 1 : 0) << '\n';
            }
            if (dts > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
                throw std::runtime_error("MSE decode timestamp exceeds validator range");
            }
            const auto chromium_decision = chromium_video_policy_.process({
                static_cast<std::int64_t>(dts), duration, bitstream_keyframe});
            if (!chromium_decision.append) {
                throw std::runtime_error(
                    "Chromium coded-frame policy would drop video sample at dts=" +
                    std::to_string(dts));
            }

            if (timeline_only_) {
                ++access_unit_count_;
                payload_position += size;
                dts += duration;
                if (access_unit_count_ >= maximum_access_units_) {
                    done_ = true;
                    previous_mse_decode_end_ = dts;
                    return;
                }
                continue;
            }

            // Model decoder input for hvc1: make the hvcC parameter sets
            // available at a coded keyframe while retaining any in-band
            // updates from the media sample.
            std::vector<std::vector<std::uint8_t>> injected;
            std::vector<NalUnit> converted;
            std::size_t first_original = 0;
            if (bitstream_keyframe && !nals.empty() && nals.front().type == 35) {
                converted.push_back(nals.front());
                first_original = 1;
            }
            if (bitstream_keyframe) {
                for (std::size_t index = 0; index < mse_config_parameter_sets_.size(); ++index) {
                    injected.push_back(mse_config_parameter_sets_[index]);
                    const auto& bytes = injected.back();
                    converted.push_back({bytes.data(), bytes.size(),
                                         static_cast<std::uint8_t>(32 + index), 0});
                }
            }
            converted.insert(converted.end(), nals.begin() +
                             static_cast<std::ptrdiff_t>(first_original), nals.end());
            remember_parameter_sets(converted);
            if (session_ == nullptr && !create_session()) {
                if (done_) return;
                throw std::runtime_error("cannot create VideoToolbox session without parameter sets");
            }
            std::vector<std::uint8_t> vt_sample;
            for (const auto& nal : converted) {
                if (nal.type != 35 && !append_nal(vt_sample, nal.data, nal.size))
                    throw std::runtime_error("HEVC NAL is too large");
            }
            if (vt_sample.empty()) throw std::runtime_error("HEVC sample is empty");

            const auto pts_signed = static_cast<std::int64_t>(dts) + composition_offset;
            if (pts_signed < 0) throw std::runtime_error("negative MSE presentation timestamp");
            pace_seconds(static_cast<double>(dts) / video_timescale_);
            ++access_unit_count_;
            const auto status = submit_sample(
                vt_sample,
                CMTimeMake(pts_signed, static_cast<std::int32_t>(video_timescale_)),
                CMTimeMake(dts, static_cast<std::int32_t>(video_timescale_)),
                bitstream_keyframe);
            std::cerr << "mse au=" << access_unit_count_
                      << " fragment=" << mse_fragment_count_
                      << " dts=" << (static_cast<double>(dts) / video_timescale_)
                      << " pts=" << (static_cast<double>(pts_signed) / video_timescale_)
                      << " metadata_key=" << (metadata_keyframe ? 1 : 0)
                      << " bitstream_key=" << (bitstream_keyframe ? 1 : 0)
                      << " nal=" << nal_types(nals) << " submit=" << status << '\n';
            if (status != noErr || callback_status_.load() != noErr) {
                pipeline_ok_ = false;
                done_ = true;
                return;
            }
            payload_position += size;
            dts += duration;
            if (access_unit_count_ >= maximum_access_units_) {
                done_ = true;
                previous_mse_decode_end_ = dts;
                return;
            }
        }
        previous_mse_decode_end_ = dts;
    }

    void validate_audio_mse_segment(const std::vector<std::uint8_t>& data) {
        const auto top = child_boxes(data, 0, data.size());
        const auto moof = box_of_type(top, "moof");
        const auto mdat = box_of_type(top, "mdat");
        if (!moof || !mdat) throw std::runtime_error("audio segment requires moof and mdat");
        const auto moof_children = child_boxes(data, moof->payload,
                                               moof->offset + moof->size);
        const auto traf = box_of_type(moof_children, "traf");
        if (!traf) throw std::runtime_error("audio moof has no traf");
        const auto traf_children = child_boxes(data, traf->payload,
                                               traf->offset + traf->size);
        const auto tfdt = box_of_type(traf_children, "tfdt");
        const auto trun = box_of_type(traf_children, "trun");
        if (!tfdt || !trun) throw std::runtime_error("audio traf requires tfdt and trun");
        if (tfdt->payload + 12 > tfdt->offset + tfdt->size ||
            trun->payload + 12 > trun->offset + trun->size) {
            throw std::runtime_error("truncated audio tfdt/trun");
        }
        if (data[tfdt->payload] != 1) {
            throw std::runtime_error("audio tfdt is not version 1");
        }
        auto dts = be64(data.data() + tfdt->payload + 4);
        const auto sample_count = be32(data.data() + trun->payload + 4);
        auto entry = trun->payload + 12;
        const auto timescale = audio_timescale_ == 0 ? 1U : audio_timescale_;
        if (previous_audio_decode_end_.has_value()) {
            if (dts < *previous_audio_decode_end_) {
                throw std::runtime_error(
                    "audio MSE timeline overlap: tfdt=" + std::to_string(dts) +
                    " previous_end=" + std::to_string(*previous_audio_decode_end_));
            }
            if (dts > *previous_audio_decode_end_) {
                const auto gap = dts - *previous_audio_decode_end_;
                ++audio_timeline_gap_count_;
                largest_audio_timeline_gap_ = std::max(largest_audio_timeline_gap_, gap);
                std::cerr << "audio timeline gap fragment=" << (audio_fragment_count_ + 1)
                          << " previous_end="
                          << (static_cast<double>(*previous_audio_decode_end_) / timescale)
                          << " next_dts=" << (static_cast<double>(dts) / timescale)
                          << " gap=" << (static_cast<double>(gap) / timescale) << '\n';
            }
        }
        ++audio_fragment_count_;
        for (std::uint32_t index = 0; index < sample_count; ++index) {
            if (entry + 16 > trun->offset + trun->size) {
                throw std::runtime_error("truncated audio trun sample table");
            }
            const auto duration = be32(data.data() + entry);
            const auto size = be32(data.data() + entry + 4);
            if (duration == 0 || size == 0) {
                throw std::runtime_error("invalid audio sample duration or size");
            }
            if (dts > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) ||
                !chromium_audio_policy_.process({
                    static_cast<std::int64_t>(dts), duration, true}).append) {
                throw std::runtime_error(
                    "Chromium coded-frame policy rejected audio sample at dts=" +
                    std::to_string(dts));
            }
            entry += 16;
            dts += duration;
            ++audio_sample_count_;
        }
        previous_audio_decode_end_ = dts;
    }

    static void output_callback(void* context, void*, const OSStatus status,
                                VTDecodeInfoFlags flags, CVImageBufferRef,
                                CMTime presentation_time, CMTime) {
        auto& probe = *static_cast<Probe*>(context);
        if (status != noErr) probe.callback_status_.store(status);
        if (status == noErr) ++probe.decoded_count_;
        std::cerr << "  callback status=" << status << " flags=0x" << std::hex << flags
                  << std::dec << " pts=" << CMTimeGetSeconds(presentation_time) << '\n';
    }

    std::optional<std::uint64_t> video_track_;
    std::optional<std::uint64_t> audio_track_;
    std::optional<std::uint64_t> fallback_video_track_;
    std::optional<std::uint64_t> fallback_audio_track_;
    std::optional<std::uint16_t> wanted_video_packet_id_;
    std::optional<std::uint16_t> wanted_audio_packet_id_;
    std::optional<std::uint16_t> wanted_fallback_video_packet_id_;
    std::optional<std::uint16_t> wanted_fallback_audio_packet_id_;
    std::array<std::vector<std::uint8_t>, 3> parameter_sets_;
    std::array<std::vector<std::uint8_t>, 3> decoder_parameter_sets_;
    CMVideoFormatDescriptionRef format_ = nullptr;
    VTDecompressionSessionRef session_ = nullptr;
    std::atomic<OSStatus> callback_status_{noErr};
    std::atomic<std::size_t> decoded_count_{0};
    std::size_t access_unit_count_ = 0;
    std::size_t maximum_access_units_ = 300;
    bool skip_leading_rasl_ = false;
    bool waiting_for_first_trailing_picture_ = false;
    double playback_rate_ = 0.0;
    std::size_t inflight_frames_ = 1;
    std::size_t frames_since_wait_ = 0;
    bool prepend_parameter_sets_on_irap_ = false;
    std::optional<double> first_dts_seconds_;
    std::chrono::steady_clock::time_point pacing_started_{};
    bool mse_pipeline_ = false;
    bool timeline_only_ = false;
    bool require_hardware_ = true;
    bool mse_flushed_ = false;
    bool pipeline_ok_ = true;
    std::uint8_t mse_nal_length_size_ = 4;
    std::array<std::vector<std::uint8_t>, 3> mse_config_parameter_sets_;
    std::optional<std::uint64_t> previous_mse_decode_end_;
    std::uint32_t video_timescale_ = 0;
    tlvdemux::detail::mse::ChromiumCodedFramePolicy chromium_video_policy_;
    std::size_t mse_fragment_count_ = 0;
    std::size_t timeline_gap_count_ = 0;
    std::uint64_t largest_timeline_gap_us_ = 0;
    std::size_t mse_pps_sample_count_ = 0;
    std::set<std::vector<std::uint8_t>> mse_pps_variants_;
    std::uint32_t audio_timescale_ = 0;
    std::optional<std::uint64_t> previous_audio_decode_end_;
    tlvdemux::detail::mse::ChromiumCodedFramePolicy chromium_audio_policy_;
    std::size_t audio_fragment_count_ = 0;
    std::size_t audio_sample_count_ = 0;
    std::size_t audio_timeline_gap_count_ = 0;
    std::uint64_t largest_audio_timeline_gap_ = 0;
    tlvdemux::MseRemuxer mse_remuxer_;
    bool automatic_layer_configured_ = false;
    bool layer_switch_completed_ = false;
    bool done_ = false;
};

} // namespace

bool tlvdemux::tools::vt_probe::run_probe(const Options& options, const std::uint64_t offset,
               const std::size_t case_index) {
    std::ifstream input(options.path, std::ios::binary);
    if (!input) {
        std::cerr << "cannot open " << options.path << '\n';
        return false;
    }

    Probe probe(options);
    auto limits = aribtlv::Limits{};
    limits.collect_application_resources = false;
    aribtlv::Demuxer demuxer(probe, limits);
    demuxer.selectService(options.service_context_id);
    if (offset != 0) {
        demuxer.reposition(aribtlv::RepositionOptions{offset, false});
        input.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
        if (!input) {
            std::cerr << "cannot seek to " << offset << '\n';
            return false;
        }
    }
    std::cerr << "case=" << case_index << " offset=" << offset << '\n';
    std::array<std::uint8_t, 1024 * 1024> chunk{};
    while (!probe.done() && input) {
        input.read(reinterpret_cast<char*>(chunk.data()),
                   static_cast<std::streamsize>(chunk.size()));
        const auto count = input.gcount();
        if (count > 0) demuxer.push(chunk.data(), static_cast<std::size_t>(count));
    }
    if (!probe.done()) demuxer.flush();
    probe.finish();
    std::cerr << "decoded=" << probe.decoded_count()
              << " final_status=" << probe.callback_status()
              << " timeline_gaps=" << probe.timeline_gap_count()
              << " largest_gap_us=" << probe.largest_timeline_gap_us()
              << " audio_samples=" << probe.audio_sample_count()
              << " audio_timeline_gaps=" << probe.audio_timeline_gap_count()
              << " largest_audio_gap=" << probe.largest_audio_timeline_gap()
              << " pps_samples=" << probe.mse_pps_sample_count()
              << " pps_variants=" << probe.mse_pps_variant_count() << '\n';
    return probe.ok();
}
