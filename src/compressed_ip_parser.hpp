#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <unordered_map>

#include "mmtp_parser.hpp"
#include "tlv_parser.hpp"

namespace tlvdemux::detail {

class CompressedIpParser {
public:
    using ServiceCallback = std::function<void(ServiceInfo)>;
    using TrackCallback = std::function<std::uint64_t(TrackInfo)>;
    using AccessUnitCallback = std::function<void(TimedAccessUnit)>;

    CompressedIpParser(const Limits&, ServiceCallback, TrackCallback,
                       AccessUnitCallback, ErrorCallback);

    void consume(const TlvPacketView&);
    void flush();
    void reset();

private:
    MmtpParser* context(std::uint32_t context_id, std::uint64_t input_offset);
    void parse_ipv6(const TlvPacketView&);
    void parse_compressed(const TlvPacketView&);

    Limits limits_;
    ServiceCallback on_service_;
    TrackCallback on_track_;
    AccessUnitCallback on_access_unit_;
    ErrorCallback on_error_;
    std::unordered_map<std::uint32_t, std::unique_ptr<MmtpParser>> contexts_;
};

} // namespace tlvdemux::detail
