#include <tlvdemux/output_format.hpp>

#include <algorithm>

namespace {

using tlvdemux::MseHdrOutputMode;
using tlvdemux::MseOutputColorSpace;

bool hdr_supported(const MseHdrOutputMode mode,
                   const tlvdemux::MseOutputCapabilities& sink,
                   const tlvdemux::MseDolbyTunnelCapabilities& dolby) noexcept {
    switch (mode) {
    case MseHdrOutputMode::Hdr10: return sink.pq_eotf;
    case MseHdrOutputMode::Hlg: return sink.hlg_eotf;
    case MseHdrOutputMode::DolbyVision: return dolby.tunnel_supported;
    case MseHdrOutputMode::Auto:
    case MseHdrOutputMode::Sdr: return mode == MseHdrOutputMode::Sdr;
    }
    return false;
}

MseHdrOutputMode select_hdr_mode(
    const tlvdemux::MseSourceVideoFormat& source,
    const tlvdemux::MseOutputCapabilities& sink,
    const tlvdemux::MseDolbyTunnelCapabilities& dolby,
    const MseHdrOutputMode requested) noexcept {
    if (requested != MseHdrOutputMode::Auto) {
        return hdr_supported(requested, sink, dolby) ? requested : MseHdrOutputMode::Sdr;
    }
    if (source.hdr_mode == MseHdrOutputMode::DolbyVision &&
        hdr_supported(source.hdr_mode, sink, dolby)) return source.hdr_mode;
    if (source.hdr_mode == MseHdrOutputMode::Hlg && sink.hlg_eotf) return source.hdr_mode;
    if (source.hdr_mode == MseHdrOutputMode::Hdr10 && sink.pq_eotf) return source.hdr_mode;
    return MseHdrOutputMode::Sdr;
}

bool choose_color_space(const tlvdemux::MseSourceVideoFormat& source,
                        const tlvdemux::MseOutputCapabilities& sink,
                        MseOutputColorSpace& result) noexcept {
    if (sink.supports_color_space(source.preferred_color_space)) {
        result = source.preferred_color_space;
        return true;
    }
    constexpr MseOutputColorSpace fallback[] = {
        MseOutputColorSpace::Rgb444,
        MseOutputColorSpace::Ycbcr444,
        MseOutputColorSpace::Ycbcr422,
        MseOutputColorSpace::Ycbcr420,
    };
    for (const auto candidate : fallback) {
        if (sink.supports_color_space(candidate)) {
            result = candidate;
            return true;
        }
    }
    return false;
}

} // namespace

tlvdemux::MseOutputFormatDecision tlvdemux::decide_mse_output_format(
    const MseSourceVideoFormat& source, const MseOutputCapabilities& sink,
    const MseDolbyTunnelCapabilities& dolby,
    const MseHdrOutputMode requested_mode) noexcept {
    MseOutputFormatDecision decision;
    if (!sink.edid_valid) return decision;
    if (sink.max_tmds_clock_mhz != 0 && source.pixel_clock_mhz > sink.max_tmds_clock_mhz) {
        return decision;
    }
    if (!choose_color_space(source, sink, decision.color_space)) return decision;
    decision.supported = true;
    decision.deep_color_bits = static_cast<std::uint8_t>(std::min(
        static_cast<unsigned>(source.bit_depth),
        static_cast<unsigned>(std::max<std::uint8_t>(8, sink.max_deep_color_bits))));
    decision.hdr_mode = select_hdr_mode(source, sink, dolby, requested_mode);
    decision.requires_sdr_conversion = source.hdr_mode != MseHdrOutputMode::Sdr &&
        decision.hdr_mode == MseHdrOutputMode::Sdr;
    return decision;
}
