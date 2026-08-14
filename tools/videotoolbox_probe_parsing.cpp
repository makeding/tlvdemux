#include "videotoolbox_probe_parsing.hpp"

#include <algorithm>

namespace tlvdemux::tools::vt_probe {

std::uint32_t be32(const std::uint8_t* data) {
    return (std::uint32_t(data[0]) << 24U) | (std::uint32_t(data[1]) << 16U) |
           (std::uint32_t(data[2]) << 8U) | std::uint32_t(data[3]);
}

std::uint16_t be16(const std::uint8_t* data) {
    return static_cast<std::uint16_t>((std::uint16_t(data[0]) << 8U) | data[1]);
}

std::uint64_t be64(const std::uint8_t* data) {
    return (std::uint64_t(be32(data)) << 32U) | be32(data + 4);
}

std::string cf_description(CFTypeRef value) {
    if (value == nullptr) return "missing";
    const auto description = CFCopyDescription(value);
    if (description == nullptr) return "unprintable";
    const auto length = CFStringGetLength(description);
    const auto capacity = CFStringGetMaximumSizeForEncoding(
        length, kCFStringEncodingUTF8) + 1;
    std::vector<char> bytes(static_cast<std::size_t>(capacity));
    const bool converted = CFStringGetCString(description, bytes.data(), capacity,
                                              kCFStringEncodingUTF8);
    CFRelease(description);
    return converted ? std::string(bytes.data()) : "unprintable";
}

std::vector<Mp4Box> child_boxes(const std::vector<std::uint8_t>& data,
                                std::size_t begin, const std::size_t end) {
    std::vector<Mp4Box> result;
    while (begin + 8 <= end) {
        std::uint64_t size = be32(data.data() + begin);
        std::size_t header = 8;
        if (size == 1) {
            if (begin + 16 > end) return {};
            size = be64(data.data() + begin + 8);
            header = 16;
        } else if (size == 0) {
            size = end - begin;
        }
        if (size < header || size > end - begin) return {};
        result.push_back({begin, static_cast<std::size_t>(size), begin + header,
                          std::string(reinterpret_cast<const char*>(
                              data.data() + begin + 4), 4)});
        begin += static_cast<std::size_t>(size);
    }
    return begin == end ? result : std::vector<Mp4Box>{};
}

std::optional<Mp4Box> box_of_type(const std::vector<Mp4Box>& boxes,
                                  const std::string& type) {
    const auto found = std::find_if(boxes.begin(), boxes.end(), [&](const auto& box) {
        return box.type == type;
    });
    if (found == boxes.end()) return std::nullopt;
    return *found;
}

std::optional<Mp4Box> find_box_signature(const std::vector<std::uint8_t>& data,
                                         const std::string& type) {
    if (type.size() != 4) return std::nullopt;
    for (std::size_t offset = 4; offset + 4 <= data.size(); ++offset) {
        if (!std::equal(type.begin(), type.end(), data.begin() +
                        static_cast<std::ptrdiff_t>(offset))) continue;
        const auto size = be32(data.data() + offset - 4);
        if (size >= 8 && offset - 4 + size <= data.size()) {
            return Mp4Box{offset - 4, size, offset + 4, type};
        }
    }
    return std::nullopt;
}

std::vector<NalUnit> split_length_prefixed(const std::uint8_t* data,
                                           const std::size_t size,
                                           const std::uint8_t length_size) {
    std::vector<NalUnit> result;
    std::size_t offset = 0;
    while (offset < size) {
        if (length_size == 0 || length_size > 4 || offset + length_size > size) return {};
        std::uint32_t nal_size = 0;
        for (std::uint8_t index = 0; index < length_size; ++index) {
            nal_size = (nal_size << 8U) | data[offset++];
        }
        if (nal_size < 2 || nal_size > size - offset) return {};
        result.push_back({data + offset, nal_size,
                          static_cast<std::uint8_t>((data[offset] >> 1U) & 0x3fU),
                          static_cast<std::uint8_t>(((data[offset] & 1U) << 5U) |
                                                    (data[offset + 1] >> 3U))});
        offset += nal_size;
    }
    return result;
}

std::vector<NalUnit> split_annex_b(const std::vector<std::uint8_t>& bytes) {
    std::vector<NalUnit> result;
    const auto start_code = [&bytes](const std::size_t offset) -> std::size_t {
        if (offset + 3 <= bytes.size() && bytes[offset] == 0 && bytes[offset + 1] == 0 &&
            bytes[offset + 2] == 1) return 3;
        if (offset + 4 <= bytes.size() && bytes[offset] == 0 && bytes[offset + 1] == 0 &&
            bytes[offset + 2] == 0 && bytes[offset + 3] == 1) return 4;
        return 0;
    };

    std::size_t cursor = 0;
    while (cursor < bytes.size()) {
        const auto prefix = start_code(cursor);
        if (prefix == 0) {
            ++cursor;
            continue;
        }
        const auto nal_start = cursor + prefix;
        auto nal_end = nal_start;
        while (nal_end < bytes.size() && start_code(nal_end) == 0) ++nal_end;
        if (nal_end > nal_start && nal_end - nal_start >= 2) {
            result.push_back({
                bytes.data() + nal_start,
                nal_end - nal_start,
                static_cast<std::uint8_t>((bytes[nal_start] >> 1U) & 0x3fU),
                static_cast<std::uint8_t>(((bytes[nal_start] & 1U) << 5U) |
                                          (bytes[nal_start + 1] >> 3U)),
            });
        }
        cursor = nal_end;
    }
    return result;
}

std::string nal_types(const std::vector<NalUnit>& nals) {
    std::string result;
    for (const auto& nal : nals) {
        if (!result.empty()) result += ',';
        result += std::to_string(nal.type);
        result += '@';
        result += std::to_string(nal.layer_id);
    }
    return result;
}

} // namespace tlvdemux::tools::vt_probe
