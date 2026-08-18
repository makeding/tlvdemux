#include "calcseek_time.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

namespace {

[[noreturn]] void fail(const std::string& message) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void check(const bool condition, const std::string& message) {
    if (!condition) fail(message);
}

void check_time(const std::string_view input, const double expected) {
    const auto value = tlvdemux::tools::parse_calcseek_time(input);
    check(value.has_value() && std::abs(*value - expected) < 1e-9,
          "wrong parsed time for " + std::string(input));
}

void check_invalid(const std::string_view input) {
    check(!tlvdemux::tools::parse_calcseek_time(input).has_value(),
          "invalid time was accepted: " + std::string(input));
}

} // namespace

int main() {
    check_time("0", 0.0);
    check_time("11.5", 11.5);
    check_time(".5", 0.5);
    check_time("5.", 5.0);
    check_time("11:11", 671.0);
    check_time("99:59", 5999.0);
    check_time("1:11:11", 4271.0);
    check_time(" 1:02.5 ", 62.5);

    check_invalid("");
    check_invalid(".");
    check_invalid("1:60");
    check_invalid("1:60:00");
    check_invalid("1:00:60");
    check_invalid("1:2:3:4");
    check_invalid("nan");
    check_invalid("inf");

    std::cout << "all calcseek time tests passed\n";
    return 0;
}
