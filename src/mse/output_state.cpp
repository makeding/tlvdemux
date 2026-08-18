#include <tlvdemux/output_capabilities.hpp>

bool tlvdemux::MseOutputStateTracker::update(
    MseOutputCapabilities capabilities, const bool connected) noexcept {
    if (state_.capabilities == capabilities && state_.connected == connected) {
        return false;
    }
    state_.capabilities = capabilities;
    state_.connected = connected;
    ++state_.generation;
    return true;
}

bool tlvdemux::MseOutputStateTracker::set_hdr_mode(
    const MseHdrOutputMode mode) noexcept {
    if (state_.hdr_mode == mode) return false;
    state_.hdr_mode = mode;
    ++state_.generation;
    return true;
}

bool tlvdemux::MseOutputStateTracker::set_dolby_tunnel(
    MseDolbyTunnelCapabilities capabilities) noexcept {
    if (state_.dolby_tunnel == capabilities) return false;
    state_.dolby_tunnel = capabilities;
    ++state_.generation;
    return true;
}
