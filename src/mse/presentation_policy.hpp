#pragma once

#include <aribtlv/video_presentation.hpp>

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
        output_supports_hlg_ = supported;
    }

    bool set_programme_hint(const aribtlv::VideoPresentationHint hint) noexcept {
        if (programme_hint_ == hint) return false;
        programme_hint_ = hint;
        return true;
    }

    void clear_programme_hint() noexcept { programme_hint_.reset(); }

    PresentationDecision decision(const bool explicit_sdr = false) const noexcept {
        switch (mode_) {
        case PresentationMode::Prototype:
            return {false, true};
        case PresentationMode::Force:
        case PresentationMode::OnCompare:
            return {true, false};
        case PresentationMode::Off:
            return {false, false};
        case PresentationMode::Auto:
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
    bool output_supports_hlg_ = true;
    std::optional<aribtlv::VideoPresentationHint> programme_hint_;
};

} // namespace tlvdemux::detail::mse
