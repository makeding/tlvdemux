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
    check(!policy.decision().sdr_in_hlg,
          "auto policy should preserve an unknown programme");

    check(policy.decision(true).sdr_in_hlg,
          "explicit B60 SDR should enable SDR-in-HLG reinterpretation");

    policy.set_programme_hint(aribtlv::VideoPresentationHint::Hdr);
    check(!policy.decision().sdr_in_hlg,
          "HDR programme should preserve HLG on a supported output");

    policy.clear_programme_hint();
    check(policy.decision(true).sdr_in_hlg,
          "explicit SDR should enable reinterpretation without an HDR hint");
    policy.set_programme_hint(aribtlv::VideoPresentationHint::Hdr);
    check(!policy.decision(true).sdr_in_hlg,
          "HDR programme must override conflicting SDR metadata");
    policy.clear_programme_hint();

    policy.set_hlg_output_supported(false);
    check(!policy.decision().sdr_in_hlg,
          "unsupported HLG output must not guess SDR for an unknown source");
}

void test_edid_controls_hlg_source_policy() {
    tlvdemux::detail::mse::PresentationPolicy policy;
    tlvdemux::MseOutputCapabilities capabilities;
    capabilities.edid_valid = true;
    capabilities.hdr_support = true;
    capabilities.pq_eotf = true;
    capabilities.hlg_eotf = false;
    policy.set_output_capabilities(capabilities);

    check(policy.decision(false, true) ==
              tlvdemux::detail::mse::PresentationDecision{false, true},
          "HLG source on an HLG-incompatible output did not select prototype");

    capabilities.hlg_eotf = true;
    policy.set_output_capabilities(capabilities);
    check(policy.decision(false, true) ==
              tlvdemux::detail::mse::PresentationDecision{false, false},
          "HLG source on an HLG-capable output was unnecessarily remapped");
}

void test_explicit_modes_are_stable() {
    tlvdemux::detail::mse::PresentationPolicy policy;
    policy.set_mode("force");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{true, false},
          "force mode did not select SDR-in-HLG");
    policy.set_mode("on_compare");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{true, false},
          "on_compare mode did not select SDR-in-HLG");
    policy.set_mode("prototype");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{false, true},
          "prototype mode did not select the prototype carrier");
    policy.set_mode("off");
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{false, false},
          "off mode did not preserve the source");
    policy.set_mode("auto");
    policy.set_programme_hint(aribtlv::VideoPresentationHint::Unknown);
    check(policy.decision() ==
              tlvdemux::detail::mse::PresentationDecision{false, false},
          "explicit unknown hint must preserve the source");
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
    test_edid_controls_hlg_source_policy();
    test_explicit_modes_are_stable();
    std::cout << "presentation policy tests passed\n";
}
