#pragma once

#include <aribtlv/video_presentation.hpp>
#include <tlvdemux/output_capabilities.hpp>

#include <stdexcept>
#include <optional>
#include <string>

namespace tlvdemux::detail::mse {

enum class PresentationMode {
    Auto,
    Force,
    OnCompare,
    Prototype,
    Off,
};

struct PresentationDecision {
    bool sdr_in_hlg = false;
    bool hlg_sdr_prototype = false;
    bool operator==(const PresentationDecision&) const = default;
};

class PresentationPolicy {
public:
    void set_mode(const std::string& mode) {
        if (mode == "auto") mode_ = PresentationMode::Auto;
        else if (mode == "force") mode_ = PresentationMode::Force;
        else if (mode == "on_compare") mode_ = PresentationMode::OnCompare;
        else if (mode == "prototype") mode_ = PresentationMode::Prototype;
        else if (mode == "off") mode_ = PresentationMode::Off;
        else throw std::invalid_argument("invalid MSE tone mapping mode");
    }

    void set_hlg_output_supported(const bool supported) noexcept {
        output_capabilities_.edid_valid = true;
        output_capabilities_.hlg_eotf = supported;
        output_capabilities_.hdr_support = supported || output_capabilities_.pq_eotf;
    }

    void set_output_capabilities(
        const tlvdemux::MseOutputCapabilities capabilities) noexcept {
        output_capabilities_ = capabilities;
    }

    bool set_programme_hint(const aribtlv::VideoPresentationHint hint) noexcept {
        if (programme_hint_ == hint) return false;
        programme_hint_ = hint;
        return true;
    }

    void clear_programme_hint() noexcept { programme_hint_.reset(); }

    PresentationDecision decision(const bool explicit_sdr = false,
                                  const bool source_hlg = false) const noexcept {
        switch (mode_) {
        case PresentationMode::Prototype:
            return {false, true};
        case PresentationMode::Force:
        case PresentationMode::OnCompare:
            return {true, false};
        case PresentationMode::Off:
            return {false, false};
        case PresentationMode::Auto:
            if (source_hlg && output_capabilities_.edid_valid &&
                !output_capabilities_.hlg_eotf) {
                return {false, true};
            }
            if (programme_hint_.has_value() &&
                *programme_hint_ == aribtlv::VideoPresentationHint::Hdr) {
                return {false, false};
            }
            // Absence of the positive HDR programme hint is not an SDR
            // assertion. Only explicit B60 SDR metadata authorizes the
            // existing signalling reinterpretation.
            return {explicit_sdr, false};
        }
        return {false, false};
    }

private:
    PresentationMode mode_ = PresentationMode::Auto;
    tlvdemux::MseOutputCapabilities output_capabilities_;
    std::optional<aribtlv::VideoPresentationHint> programme_hint_;
};

} // namespace tlvdemux::detail::mse
