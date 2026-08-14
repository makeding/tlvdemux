#pragma once

#include <CoreFoundation/CoreFoundation.h>

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux::tools::vt_probe {

struct NalUnit {
    const std::uint8_t* data = nullptr;
    std::size_t size = 0;
    std::uint8_t type = 0;
    std::uint8_t layer_id = 0;
};

struct Mp4Box {
    std::size_t offset = 0;
    std::size_t size = 0;
    std::size_t payload = 0;
    std::string type;
};

std::uint16_t be16(const std::uint8_t* data);
std::uint32_t be32(const std::uint8_t* data);
std::uint64_t be64(const std::uint8_t* data);
std::string cf_description(CFTypeRef value);
std::vector<Mp4Box> child_boxes(const std::vector<std::uint8_t>& data,
                                std::size_t begin, std::size_t end);
std::optional<Mp4Box> box_of_type(const std::vector<Mp4Box>& boxes,
                                  const std::string& type);
std::optional<Mp4Box> find_box_signature(const std::vector<std::uint8_t>& data,
                                         const std::string& type);
std::vector<NalUnit> split_length_prefixed(const std::uint8_t* data,
                                           std::size_t size,
                                           std::uint8_t length_size);
std::vector<NalUnit> split_annex_b(const std::vector<std::uint8_t>& bytes);
std::string nal_types(const std::vector<NalUnit>& nals);

} // namespace tlvdemux::tools::vt_probe
