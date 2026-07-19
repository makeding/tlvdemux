#include <tlvdemux/demuxer.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct TestSink final : tlvdemux::Sink {
    std::vector<tlvdemux::ServiceInfo> services;
    std::vector<tlvdemux::TrackInfo> tracks;
    std::vector<tlvdemux::AccessUnit> access_units;
    std::vector<tlvdemux::Error> errors;
    void onService(const tlvdemux::ServiceInfo& value) override { services.push_back(value); }
    void onTrack(const tlvdemux::TrackInfo& value) override { tracks.push_back(value); }
    void onAccessUnit(tlvdemux::AccessUnit&& value) override {
        access_units.push_back(std::move(value));
    }
    void onError(const tlvdemux::Error& value) override { errors.push_back(value); }
};

[[noreturn]] void fail(const std::string& message) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void check(const bool condition, const std::string& message) {
    if (!condition) fail(message);
}

std::vector<std::uint8_t> mmtp_signalling(const std::uint16_t packet_id,
                                          const std::uint32_t sequence) {
    return {
        0x00, 0x02,
        static_cast<std::uint8_t>(packet_id >> 8U), static_cast<std::uint8_t>(packet_id),
        0, 0, 0, 0,
        static_cast<std::uint8_t>(sequence >> 24U), static_cast<std::uint8_t>(sequence >> 16U),
        static_cast<std::uint8_t>(sequence >> 8U), static_cast<std::uint8_t>(sequence),
        0x00, 0x00, 0x00, 0x00,
    };
}

std::vector<std::uint8_t> compressed(const std::uint16_t context_id,
                                     const std::uint16_t packet_id,
                                     const std::uint32_t sequence) {
    auto mmtp = mmtp_signalling(packet_id, sequence);
    std::vector<std::uint8_t> result{
        static_cast<std::uint8_t>((context_id << 4U) >> 8U),
        static_cast<std::uint8_t>(context_id << 4U),
        0x61,
    };
    result.insert(result.end(), mmtp.begin(), mmtp.end());
    return result;
}

std::vector<std::uint8_t> tlv(const std::uint8_t type,
                              const std::vector<std::uint8_t>& payload) {
    std::vector<std::uint8_t> result{
        0x7f, type,
        static_cast<std::uint8_t>(payload.size() >> 8U),
        static_cast<std::uint8_t>(payload.size()),
    };
    result.insert(result.end(), payload.begin(), payload.end());
    return result;
}

std::vector<std::uint8_t> stream_for_contexts(const std::uint16_t first,
                                              const std::uint16_t second) {
    auto result = tlv(0x03, compressed(first, 0x8000, 1));
    const auto tail = tlv(0x03, compressed(second, 0x8000, 1));
    result.insert(result.end(), tail.begin(), tail.end());
    return result;
}

void test_split_at_every_boundary() {
    const auto data = stream_for_contexts(1, 2);
    for (std::size_t split = 0; split <= data.size(); ++split) {
        TestSink sink;
        tlvdemux::Demuxer demuxer(sink);
        demuxer.push(data.data(), split);
        demuxer.push(data.data() + split, data.size() - split);
        demuxer.flush();
        check(sink.services.size() == 2, "TLV split changed discovered context count");
    }
}

void test_one_byte_input() {
    const auto data = stream_for_contexts(7, 8);
    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    for (const auto byte : data) demuxer.push(&byte, 1);
    demuxer.flush();
    check(sink.services.size() == 2, "one-byte pushes did not match whole-stream parsing");
}

void test_garbage_recovery() {
    auto data = stream_for_contexts(1, 2);
    const auto third = stream_for_contexts(3, 4);
    data.insert(data.end(), {0xde, 0xad, 0x7f, 0x03, 0xff, 0xff, 0xbe, 0xef});
    data.insert(data.end(), third.begin(), third.end());

    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(sink.services.size() == 4, "parser did not recover after middle garbage");
    check(std::any_of(sink.errors.begin(), sink.errors.end(), [](const auto& error) {
        return error.code == tlvdemux::ErrorCode::MalformedInput;
    }), "garbage recovery did not report a recoverable error");
}

void test_service_selection_and_reset() {
    const auto data = stream_for_contexts(10, 11);
    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.selectService(11);
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(sink.services.size() == 1 && sink.services[0].context_id == 11,
          "service selection leaked another context");

    demuxer.reset();
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(sink.services.size() == 2, "reset did not make selected service discoverable again");
}

void test_incomplete_flush() {
    auto data = stream_for_contexts(1, 2);
    data.resize(data.size() - 3);
    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(!sink.errors.empty(), "flush did not report incomplete trailing data");
}

void test_mode_60_and_resource_limit() {
    auto mmtp = mmtp_signalling(0x8000, 1);
    std::vector<std::uint8_t> payload{0x12, 0x30, 0x60};
    payload.insert(payload.end(), 42, 0);
    payload.insert(payload.end(), mmtp.begin(), mmtp.end());
    const auto packet = tlv(0x03, payload);
    auto stream = packet;
    stream.insert(stream.end(), packet.begin(), packet.end());

    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.push(stream.data(), stream.size());
    demuxer.flush();
    check(sink.services.size() == 1 && sink.services[0].context_id == 0x123,
          "compressed-IP mode 0x60 did not preserve its context ID");

    tlvdemux::Limits limits;
    limits.max_resync_buffer = 16;
    TestSink limited_sink;
    tlvdemux::Demuxer limited(limited_sink, limits);
    std::vector<std::uint8_t> garbage(128, 0x55);
    limited.push(garbage.data(), garbage.size());
    limited.flush();
    check(std::any_of(limited_sink.errors.begin(), limited_sink.errors.end(), [](const auto& error) {
        return error.code == tlvdemux::ErrorCode::ResourceLimit;
    }), "TLV resynchronization buffer limit was not enforced");
}

void append_u16(std::vector<std::uint8_t>& value, const std::size_t number) {
    value.push_back(static_cast<std::uint8_t>(number >> 8U));
    value.push_back(static_cast<std::uint8_t>(number));
}

void append_u32(std::vector<std::uint8_t>& value, const std::size_t number) {
    value.push_back(static_cast<std::uint8_t>(number >> 24U));
    value.push_back(static_cast<std::uint8_t>(number >> 16U));
    value.push_back(static_cast<std::uint8_t>(number >> 8U));
    value.push_back(static_cast<std::uint8_t>(number));
}

void descriptor(std::vector<std::uint8_t>& value, const std::uint16_t tag,
                const std::vector<std::uint8_t>& payload) {
    append_u16(value, tag);
    value.push_back(static_cast<std::uint8_t>(payload.size()));
    value.insert(value.end(), payload.begin(), payload.end());
}

void append_u64(std::vector<std::uint8_t>& value, const std::uint64_t number) {
    append_u32(value, static_cast<std::uint32_t>(number >> 32U));
    append_u32(value, static_cast<std::uint32_t>(number));
}

void timing_descriptors(std::vector<std::uint8_t>& value,
                        const std::uint32_t mpu_sequence,
                        const std::uint32_t timescale) {
    std::vector<std::uint8_t> timestamp;
    append_u32(timestamp, mpu_sequence);
    append_u64(timestamp, 100ULL << 32U);
    descriptor(value, 0x0001, timestamp);

    std::vector<std::uint8_t> extended{0x03};
    append_u32(extended, timescale);
    append_u16(extended, 3000);
    append_u32(extended, mpu_sequence);
    extended.push_back(0);
    append_u16(extended, 0);
    extended.push_back(1);
    append_u16(extended, 0);
    descriptor(value, 0x8026, extended);
}

void asset(std::vector<std::uint8_t>& body, const std::uint16_t packet_id,
           const std::string& type, const std::vector<std::uint8_t>& descriptors) {
    body.push_back(0);
    append_u32(body, 0);
    body.push_back(2);
    append_u16(body, packet_id);
    body.insert(body.end(), type.begin(), type.end());
    body.push_back(0xfe);
    body.push_back(1);
    body.push_back(0);
    append_u16(body, packet_id);
    append_u16(body, descriptors.size());
    body.insert(body.end(), descriptors.begin(), descriptors.end());
}

std::vector<std::uint8_t> discovery_stream() {
    std::vector<std::uint8_t> video_descriptors;
    descriptor(video_descriptors, 0x8011, {0x00, 0x00});
    descriptor(video_descriptors, 0x8010, {0, 0, 0, 0, 0, 'j', 'p', 'n'});
    timing_descriptors(video_descriptors, 1, 180000);

    std::vector<std::uint8_t> audio_descriptors;
    descriptor(audio_descriptors, 0x8011, {0x00, 0x10});
    descriptor(audio_descriptors, 0x8014,
               {0xf3, 0x03, 0x00, 0x10, 0x11, 0xff, 0x5f, 'j', 'p', 'n'});
    timing_descriptors(audio_descriptors, 1, 180000);

    std::vector<std::uint8_t> subtitle_descriptors;
    descriptor(subtitle_descriptors, 0x8011, {0x00, 0x30});
    descriptor(subtitle_descriptors, 0x8020,
               {0x00, 0x20, 0x30, 0x07, 'j', 'p', 'n', 0x01});

    std::vector<std::uint8_t> mpt_body{0xfc, 2, 0x00, 0x65, 0x00, 0x00, 3};
    asset(mpt_body, 0xf300, "hev1", video_descriptors);
    asset(mpt_body, 0xf310, "mp4a", audio_descriptors);
    asset(mpt_body, 0xf330, "stpp", subtitle_descriptors);
    std::vector<std::uint8_t> mpt{0x20, 8};
    append_u16(mpt, mpt_body.size());
    mpt.insert(mpt.end(), mpt_body.begin(), mpt_body.end());

    std::vector<std::uint8_t> pa{0x00, 0x00, 0x00};
    append_u32(pa, 1 + mpt.size());
    pa.push_back(0);
    pa.insert(pa.end(), mpt.begin(), mpt.end());

    auto mmtp = mmtp_signalling(0xff02, 1);
    mmtp.resize(12);
    mmtp.push_back(0);
    mmtp.push_back(0);
    mmtp.insert(mmtp.end(), pa.begin(), pa.end());
    std::vector<std::uint8_t> compressed_payload{0x00, 0x10, 0x61};
    compressed_payload.insert(compressed_payload.end(), mmtp.begin(), mmtp.end());
    const auto packet = tlv(0x03, compressed_payload);
    auto stream = packet;
    stream.insert(stream.end(), packet.begin(), packet.end());
    return stream;
}

void test_track_discovery_and_deduplication() {
    const auto data = discovery_stream();
    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(sink.tracks.size() == 3, "MPT did not discover exactly three supported tracks");
    check(sink.tracks[0].codec == tlvdemux::Codec::Hevc && sink.tracks[0].timescale == 180000,
          "HEVC metadata was not parsed from MPT descriptors");
    check(sink.tracks[1].codec == tlvdemux::Codec::AacLatm && sink.tracks[1].language == "jpn",
          "AAC-LATM metadata was not parsed from MPT descriptors");
    check(sink.tracks[2].codec == tlvdemux::Codec::Ttml && sink.tracks[2].component_tag == 0x30,
          "TTML metadata was not parsed from MPT descriptors");
    check(sink.tracks[2].timescale == 65536,
          "TTML without a timestamp descriptor did not use short-NTP timescale");

    const auto stable_id = sink.tracks[0].track_id;
    demuxer.reset();
    demuxer.push(data.data(), data.size());
    demuxer.flush();
    check(sink.tracks.size() == 6 && sink.tracks[3].track_id == stable_id,
          "reset changed a track's Demuxer-lifetime stable identity");
}

std::vector<std::uint8_t> mmtp_packet(const std::uint16_t packet_id,
                                      const std::uint32_t packet_sequence,
                                      const std::uint32_t delivery_timestamp,
                                      const bool random_access,
                                      const std::vector<std::uint8_t>& payload) {
    std::vector<std::uint8_t> result{
        static_cast<std::uint8_t>(random_access ? 1 : 0), 0x00,
        static_cast<std::uint8_t>(packet_id >> 8U), static_cast<std::uint8_t>(packet_id),
    };
    append_u32(result, delivery_timestamp);
    append_u32(result, packet_sequence);
    result.insert(result.end(), payload.begin(), payload.end());
    return result;
}

std::vector<std::uint8_t> mpu_payload(const std::uint32_t mpu_sequence,
                                      const std::vector<std::uint8_t>& mfu) {
    std::vector<std::uint8_t> result;
    append_u16(result, 6 + 14 + mfu.size());
    result.push_back(0x28);
    result.push_back(0);
    append_u32(result, mpu_sequence);
    append_u32(result, 0);
    append_u32(result, 0);
    append_u32(result, 0);
    result.push_back(0);
    result.push_back(0);
    result.insert(result.end(), mfu.begin(), mfu.end());
    return result;
}

std::vector<std::uint8_t> tlv_for_mmtp(const std::uint16_t context_id,
                                       const std::vector<std::uint8_t>& mmtp) {
    std::vector<std::uint8_t> payload{
        static_cast<std::uint8_t>((context_id << 4U) >> 8U),
        static_cast<std::uint8_t>(context_id << 4U), 0x61,
    };
    payload.insert(payload.end(), mmtp.begin(), mmtp.end());
    return tlv(0x03, payload);
}

void test_codec_output_and_timeline() {
    auto stream = discovery_stream();
    auto add_media = [&](const std::uint16_t packet_id, const std::uint32_t packet_sequence,
                         const bool rap, const std::vector<std::uint8_t>& mfu) {
        const auto packet = tlv_for_mmtp(
            1, mmtp_packet(packet_id, packet_sequence, 100U << 16U, rap,
                           mpu_payload(1, mfu)));
        stream.insert(stream.end(), packet.begin(), packet.end());
    };

    add_media(0xf300, 1, true, {0, 0, 0, 2, 0x46, 0x01});
    add_media(0xf300, 2, false, {0, 0, 0, 3, 0x02, 0x01, 0x80});
    add_media(0xf300, 3, false, {0, 0, 0, 2, 0x46, 0x01});
    add_media(0xf310, 1, true, {0x11, 0x22});
    add_media(0xf330, 1, true, {0x30, 0x01, 0x00, 0x00, 0x00, 0x00, 0x05,
                                '<', 't', 't', '/', '>'});

    TestSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.push(stream.data(), stream.size());
    demuxer.flush();

    check(sink.access_units.size() >= 3, "supported codec MFUs did not produce access units");
    const auto video = std::find_if(sink.access_units.begin(), sink.access_units.end(), [](const auto& unit) {
        return unit.codec == tlvdemux::Codec::Hevc;
    });
    const auto audio = std::find_if(sink.access_units.begin(), sink.access_units.end(), [](const auto& unit) {
        return unit.codec == tlvdemux::Codec::AacLatm;
    });
    const auto subtitle = std::find_if(sink.access_units.begin(), sink.access_units.end(), [](const auto& unit) {
        return unit.codec == tlvdemux::Codec::Ttml;
    });
    check(video != sink.access_units.end() &&
              video->data == std::vector<std::uint8_t>({0, 0, 1, 0x46, 0x01,
                                                        0, 0, 1, 0x02, 0x01, 0x80}),
          "HEVC MFUs were not assembled into one Annex-B access unit");
    check(audio != sink.access_units.end() &&
              audio->data == std::vector<std::uint8_t>({0x56, 0xe0, 0x02, 0x11, 0x22}),
          "AAC MFU was not wrapped in a valid LOAS header");
    check(subtitle != sink.access_units.end() &&
              subtitle->data == std::vector<std::uint8_t>({'<', 't', 't', '/', '>'}),
          "TTML payload was not emitted unchanged");
    check(video->pts.value == 0 && video->dts.value == 0,
          "first selected media timestamp was not normalized to zero");
}

} // namespace

int main() {
    test_split_at_every_boundary();
    test_one_byte_input();
    test_garbage_recovery();
    test_service_selection_and_reset();
    test_incomplete_flush();
    test_mode_60_and_resource_limit();
    test_track_discovery_and_deduplication();
    test_codec_output_and_timeline();
    std::cout << "all tests passed\n";
    return 0;
}
