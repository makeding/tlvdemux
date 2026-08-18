#include "calcseek_time.hpp"

#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <exception>
#include <string>

namespace tlvdemux::tools {
namespace {

std::string_view trim(const std::string_view text) {
    std::size_t first = 0;
    while (first < text.size() && std::isspace(static_cast<unsigned char>(text[first]))) {
        ++first;
    }
    std::size_t last = text.size();
    while (last > first && std::isspace(static_cast<unsigned char>(text[last - 1]))) {
        --last;
    }
    return text.substr(first, last - first);
}

std::optional<double> parse_number(const std::string_view text) {
    if (text.empty()) return std::nullopt;
    const std::string value(text);
    std::size_t consumed = 0;
    double result = 0.0;
    try {
        result = std::stod(value, &consumed);
    } catch (const std::exception&) {
        return std::nullopt;
    }
    if (consumed != value.size() || !std::isfinite(result) || result < 0.0) {
        return std::nullopt;
    }
    return result;
}

bool whole_number(const double value) {
    return std::isfinite(value) && std::floor(value) == value;
}

} // namespace

std::optional<double> parse_calcseek_time(const std::string_view input) {
    const auto text = trim(input);
    if (text.empty()) return std::nullopt;

    const auto first_colon = text.find(':');
    if (first_colon == std::string_view::npos) return parse_number(text);

    const auto second_colon = text.find(':', first_colon + 1);
    const auto third_colon = second_colon == std::string_view::npos
        ? std::string_view::npos : text.find(':', second_colon + 1);
    if (third_colon != std::string_view::npos) return std::nullopt;

    const auto first = parse_number(text.substr(0, first_colon));
    if (!first || !whole_number(*first)) return std::nullopt;

    if (second_colon == std::string_view::npos) {
        const auto seconds = parse_number(text.substr(first_colon + 1));
        if (!seconds || *seconds >= 60.0) return std::nullopt;
        const auto result = *first * 60.0 + *seconds;
        return std::isfinite(result) ? std::optional<double>(result) : std::nullopt;
    }

    const auto minutes = parse_number(
        text.substr(first_colon + 1, second_colon - first_colon - 1));
    const auto seconds = parse_number(text.substr(second_colon + 1));
    if (!minutes || !whole_number(*minutes) || *minutes >= 60.0 ||
        !seconds || *seconds >= 60.0) {
        return std::nullopt;
    }
    const auto result = *first * 3600.0 + *minutes * 60.0 + *seconds;
    return std::isfinite(result) ? std::optional<double>(result) : std::nullopt;
}

} // namespace tlvdemux::tools
