#include "mse/presentation_policy.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>

namespace {

void check(const bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void test_auto_uses_programme_hint_and_output_capability() {
    tlvdemux::detail::mse::PresentationPolicy policy;
    check(policy.decision().sdr_in_hlg,
          "auto policy should protect an unknown programme on HLG output");

    policy.set_programme_hint(aribtlv::VideoPresentationHint::Hdr);
    check(!policy.decision().sdr_in_hlg,
          "HDR programme should preserve HLG on a supported output");

    policy.clear_programme_hint();
    check(!policy.decision(true).sdr_in_hlg,
          "HDR-coded source should preserve HLG without a programme hint");

    policy.set_hlg_output_supported(false);
    check(policy.decision().sdr_in_hlg,
          "unsupported HLG output should request SDR-in-HLG");
}

void test_explicit_modes_are_stable() {
    tlvdemux::detail::mse::PresentationPolicy policy;
    policy.set_mode("prototype");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{false, true},
          "prototype mode did not select the prototype carrier");
    policy.set_mode("off");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{false, false},
          "off mode did not preserve the source");
    bool rejected = false;
    try {
        policy.set_mode("invalid");
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "invalid presentation mode was accepted");
}

} // namespace

int main() {
    test_auto_uses_programme_hint_and_output_capability();
    test_explicit_modes_are_stable();
    std::cout << "presentation policy tests passed\n";
}
