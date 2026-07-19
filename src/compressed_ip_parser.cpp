#include "compressed_ip_parser.hpp"

#include <utility>

namespace tlvdemux::detail {

CompressedIpParser::CompressedIpParser(const Limits& limits, ServiceCallback on_service,
                                       TrackCallback on_track, AccessUnitCallback on_access_unit,
                                       ErrorCallback on_error)
    : limits_(limits), on_service_(std::move(on_service)), on_track_(std::move(on_track)),
      on_access_unit_(std::move(on_access_unit)), on_error_(std::move(on_error)) {}

void CompressedIpParser::reset() {
    contexts_.clear();
}

void CompressedIpParser::flush() {
    for (auto& entry : contexts_) {
        entry.second->flush();
    }
}

MmtpParser* CompressedIpParser::context(const std::uint32_t context_id,
                                        const std::uint64_t input_offset) {
    const auto found = contexts_.find(context_id);
    if (found != contexts_.end()) {
        return found->second.get();
    }
    if (contexts_.size() >= limits_.max_contexts) {
        on_error_(ErrorCode::ResourceLimit, input_offset, true,
                  "compressed-IP context limit exceeded");
        return nullptr;
    }
    auto parser = std::make_unique<MmtpParser>(
        context_id, limits_,
        [this](const std::uint32_t id, std::vector<std::uint8_t> package_id) {
            on_service_(ServiceInfo{id, std::move(package_id)});
        },
        on_track_, on_access_unit_, on_error_);
    auto* result = parser.get();
    contexts_.emplace(context_id, std::move(parser));
    on_service_(ServiceInfo{context_id, {}});
    return result;
}

void CompressedIpParser::consume(const TlvPacketView& packet) {
    switch (packet.type) {
    case 0x02:
        parse_ipv6(packet);
        break;
    case 0x03:
        parse_compressed(packet);
        break;
    case 0xfe:
    case 0xff:
        break;
    default:
        on_error_(ErrorCode::UnsupportedFeature, packet.input_offset, true,
                  "unsupported TLV packet type");
        break;
    }
}

void CompressedIpParser::parse_ipv6(const TlvPacketView& packet) {
    if (packet.size < 48) {
        on_error_(ErrorCode::MalformedInput, packet.input_offset, true,
                  "truncated IPv6/UDP TLV payload");
        return;
    }
    if ((packet.payload[0] >> 4U) != 6 || packet.payload[6] != 17) {
        on_error_(ErrorCode::UnsupportedFeature, packet.input_offset, true,
                  "unsupported IPv6 next-header in TLV payload");
        return;
    }
    const auto ipv6_payload_size = static_cast<std::size_t>(read_be16(packet.payload + 4));
    if (ipv6_payload_size != packet.size - 40) {
        on_error_(ErrorCode::MalformedInput, packet.input_offset, true,
                  "IPv6 payload length does not match TLV payload");
        return;
    }
    const auto* udp = packet.payload + 40;
    const auto udp_size = static_cast<std::size_t>(read_be16(udp + 4));
    if (udp_size < 8 || udp_size != packet.size - 40) {
        on_error_(ErrorCode::MalformedInput, packet.input_offset, true,
                  "UDP length does not match IPv6 payload");
        return;
    }
    const auto destination_port = read_be16(udp + 2);
    if (destination_port != 123) {
        on_error_(ErrorCode::UnsupportedFeature, packet.input_offset, true,
                  "unsupported IPv6 UDP payload (only NTP is recognized in v1)");
    }
}

void CompressedIpParser::parse_compressed(const TlvPacketView& packet) {
    if (packet.size < 3) {
        on_error_(ErrorCode::MalformedInput, packet.input_offset, true,
                  "truncated compressed-IP header");
        return;
    }
    const auto context_id = static_cast<std::uint32_t>(read_be16(packet.payload) >> 4U);
    const auto mode = packet.payload[2];
    std::size_t cursor = 3;
    if (mode == 0x60) {
        constexpr std::size_t partial_ipv6_and_udp_size = 38 + 4;
        if (packet.size - cursor < partial_ipv6_and_udp_size) {
            on_error_(ErrorCode::MalformedInput, packet.input_offset, true,
                      "truncated partial IPv6/UDP compressed header");
            return;
        }
        cursor += partial_ipv6_and_udp_size;
    } else if (mode != 0x61) {
        on_error_(mode == 0x20 || mode == 0x21
                      ? ErrorCode::UnsupportedFeature
                      : ErrorCode::MalformedInput,
                  packet.input_offset, true,
                  "unsupported compressed-IP context identification mode");
        return;
    }

    auto* parser = context(context_id, packet.input_offset);
    if (parser == nullptr) {
        return;
    }
    parser->push(packet.payload + cursor, packet.size - cursor, packet.input_offset);
}

} // namespace tlvdemux::detail
