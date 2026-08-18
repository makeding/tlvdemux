#pragma once

#include <optional>
#include <string_view>

namespace tlvdemux::tools {

std::optional<double> parse_calcseek_time(std::string_view text);

} // namespace tlvdemux::tools
