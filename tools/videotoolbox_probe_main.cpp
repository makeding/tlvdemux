#include "videotoolbox_probe.hpp"

#include "mac_display_hdr.hpp"
#include "recording_time_seek.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using tlvdemux::tools::vt_probe::Options;

Options parse_options(const int argc, char** argv) {
    Options options;
    bool legacy_maximum_seen = false;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        const auto value = [&](const char* name) -> std::string {
            if (++index >= argc) {
                std::cerr << "missing value for " << name << '\n';
                std::exit(2);
            }
            return argv[index];
        };
        if (argument == "--skip-leading-rasl") {
            options.skip_leading_rasl = true;
        } else if (argument == "--mse") {
            options.mse_pipeline = true;
        } else if (argument == "--timeline-only") {
            options.timeline_only = true;
        } else if (argument == "--allow-software") {
            options.require_hardware = false;
        } else if (argument == "--expect-rainfall-init") {
            options.expect_rainfall_init = true;
        } else if (argument == "--service") {
            options.service_context_id = static_cast<std::uint32_t>(
                std::strtoul(value("--service").c_str(), nullptr, 0));
        } else if (argument == "--video-packet-id") {
            options.video_packet_id = static_cast<std::uint16_t>(
                std::strtoul(value("--video-packet-id").c_str(), nullptr, 0));
        } else if (argument == "--audio-packet-id") {
            options.audio_packet_id = static_cast<std::uint16_t>(
                std::strtoul(value("--audio-packet-id").c_str(), nullptr, 0));
        } else if (argument == "--fallback-video-packet-id") {
            options.fallback_video_packet_id = static_cast<std::uint16_t>(
                std::strtoul(value("--fallback-video-packet-id").c_str(), nullptr, 0));
        } else if (argument == "--fallback-audio-packet-id") {
            options.fallback_audio_packet_id = static_cast<std::uint16_t>(
                std::strtoul(value("--fallback-audio-packet-id").c_str(), nullptr, 0));
        } else if (argument == "--random-seeks") {
            options.random_seeks = static_cast<std::size_t>(
                std::strtoull(value("--random-seeks").c_str(), nullptr, 0));
        } else if (argument == "--seed") {
            options.seed = std::strtoull(value("--seed").c_str(), nullptr, 0);
        } else if (argument == "--target-seconds") {
            options.target_seconds = std::strtod(value("--target-seconds").c_str(), nullptr);
        } else if (argument == "--prepend-parameter-sets-on-irap") {
            options.prepend_parameter_sets_on_irap = true;
        } else if (argument == "--max-au") {
            options.maximum_access_units = static_cast<std::size_t>(
                std::strtoull(value("--max-au").c_str(), nullptr, 0));
        } else if (argument == "--offset") {
            options.offset = std::strtoull(value("--offset").c_str(), nullptr, 0);
        } else if (argument == "--rate") {
            options.playback_rate = std::strtod(value("--rate").c_str(), nullptr);
        } else if (argument == "--inflight") {
            options.inflight_frames = static_cast<std::size_t>(
                std::strtoull(value("--inflight").c_str(), nullptr, 0));
        } else if (!argument.empty() && argument[0] == '-') {
            std::cerr << "unknown option: " << argument << '\n';
            std::exit(2);
        } else if (options.path.empty()) {
            options.path = argument;
        } else if (!legacy_maximum_seen) {
            options.maximum_access_units = static_cast<std::size_t>(
                std::strtoull(argument.c_str(), nullptr, 0));
            legacy_maximum_seen = true;
        } else {
            std::cerr << "unexpected argument: " << argument << '\n';
            std::exit(2);
        }
    }
    if (options.path.empty() || options.maximum_access_units == 0 ||
        options.inflight_frames == 0 ||
        options.playback_rate < 0.0) {
        std::cerr << "usage: tlvdemux-videotoolbox-probe FILE.mmts [MAX_AU] "
                     "[--max-au N] [--offset BYTES] [--rate X] "
                     "[--inflight N] [--skip-leading-rasl] "
                     "[--prepend-parameter-sets-on-irap] [--mse] "
                     "[--timeline-only] [--service ID] [--video-packet-id ID] "
                     "[--audio-packet-id ID] [--fallback-video-packet-id ID] "
                     "[--fallback-audio-packet-id ID] [--allow-software] "
                     "[--expect-rainfall-init] "
                     "[--random-seeks N] [--seed N] [--target-seconds N]\n";
        std::exit(2);
    }
    if (options.timeline_only && !options.mse_pipeline) {
        std::cerr << "--timeline-only requires --mse\n";
        std::exit(2);
    }
    if (options.fallback_video_packet_id.has_value() !=
            options.fallback_audio_packet_id.has_value() ||
        (options.fallback_video_packet_id.has_value() &&
         (!options.mse_pipeline || !options.video_packet_id.has_value() ||
          !options.audio_packet_id.has_value()))) {
        std::cerr << "fallback A/V packet ids require --mse and both preferred packet ids\n";
        std::exit(2);
    }
    if (options.expect_rainfall_init &&
        !options.fallback_video_packet_id.has_value()) {
        std::cerr << "--expect-rainfall-init requires fallback A/V packet ids\n";
        std::exit(2);
    }
    if (options.target_seconds.has_value() &&
        (options.offset != 0 || options.random_seeks != 0)) {
        std::cerr << "--target-seconds cannot be combined with --offset or --random-seeks\n";
        std::exit(2);
    }
    return options;
}

} // namespace

int main(int argc, char** argv) {
    const auto options = parse_options(argc, argv);
    tlvdemux::tools::log_mac_display_hdr(std::cerr);
    std::ifstream size_input(options.path, std::ios::binary | std::ios::ate);
    if (!size_input) {
        std::cerr << "cannot open " << options.path << '\n';
        return 2;
    }
    const auto end = size_input.tellg();
    if (end <= 0) {
        std::cerr << "empty input " << options.path << '\n';
        return 2;
    }
    const auto file_size = static_cast<std::uint64_t>(end);
    std::vector<std::uint64_t> offsets;
    if (options.target_seconds.has_value()) {
        try {
            const auto target = tlvdemux::tools::locate_recording_time(
                options.path, *options.target_seconds, std::cerr,
                {options.service_context_id, options.video_packet_id});
            std::cerr << "target-seconds=" << *options.target_seconds
                      << " first-pts-us=" << target.first_pts_us
                      << " target-pts-us=" << target.target_pts_us
                      << " sync-pts-us=" << target.point.presentation_time.value
                      << " signalling-offset=" << target.point.signalling_offset
                      << " random-access-offset=" << target.point.random_access_offset
                      << " seek-points=" << target.seek_point_count << '\n';
            offsets.push_back(target.point.signalling_offset);
        } catch (const std::exception& error) {
            std::cerr << "target lookup failed: " << error.what() << '\n';
            return 2;
        }
    } else {
        offsets.push_back(options.offset);
    }
    std::mt19937_64 random(options.seed);
    // Keep at least 4 MiB after a landing point so a short tail does not turn
    // into a false decoder failure merely because it contains no following RAP.
    const auto random_limit = file_size > 4U * 1024U * 1024U
        ? file_size - 4U * 1024U * 1024U : file_size - 1;
    for (std::size_t index = 0; index < options.random_seeks; ++index) {
        offsets.push_back(std::uniform_int_distribution<std::uint64_t>(0, random_limit)(random));
    }
    bool passed = true;
    for (std::size_t index = 0; index < offsets.size(); ++index) {
        if (!tlvdemux::tools::vt_probe::run_probe(options, offsets[index], index)) passed = false;
    }
    std::cerr << "cocktail cases=" << offsets.size() << " result="
              << (passed ? "PASS" : "FAIL") << '\n';
    return passed ? 0 : 1;
}
