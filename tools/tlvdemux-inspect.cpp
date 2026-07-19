#include <tlvdemux/demuxer.hpp>

#include <array>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace {

const char* codec_name(const tlvdemux::Codec codec) {
    switch (codec) {
    case tlvdemux::Codec::Hevc: return "hevc";
    case tlvdemux::Codec::AacLatm: return "aac-latm";
    case tlvdemux::Codec::Ttml: return "ttml";
    }
    return "unknown";
}

const char* error_name(const tlvdemux::ErrorCode code) {
    switch (code) {
    case tlvdemux::ErrorCode::MalformedInput: return "malformed-input";
    case tlvdemux::ErrorCode::UnsupportedFeature: return "unsupported-feature";
    case tlvdemux::ErrorCode::Discontinuity: return "discontinuity";
    case tlvdemux::ErrorCode::ResourceLimit: return "resource-limit";
    }
    return "unknown";
}

struct Inspector final : tlvdemux::Sink {
    bool list = false;
    bool trace = false;
    std::unordered_map<std::uint64_t, tlvdemux::TrackInfo> tracks;
    std::optional<std::uint64_t> video_track;
    std::optional<std::uint64_t> audio_track;
    std::optional<std::uint64_t> subtitle_track;
    std::ofstream video;
    std::ofstream audio;
    std::ofstream subtitle;

    void onService(const tlvdemux::ServiceInfo& info) override {
        if (list) {
            std::cerr << "service context=" << info.context_id
                      << " package-id-bytes=" << info.package_id.size() << '\n';
        }
    }

    void onTrack(const tlvdemux::TrackInfo& info) override {
        tracks[info.track_id] = info;
        if (info.kind == tlvdemux::TrackKind::Video && !video_track.has_value()) video_track = info.track_id;
        if (info.kind == tlvdemux::TrackKind::Audio && !audio_track.has_value()) audio_track = info.track_id;
        if (info.kind == tlvdemux::TrackKind::Subtitle && !subtitle_track.has_value()) subtitle_track = info.track_id;
        if (list) {
            std::cerr << "track id=" << info.track_id << " context=" << info.context_id
                      << " packet-id=0x" << std::hex << info.packet_id << std::dec
                      << " codec=" << codec_name(info.codec)
                      << " language=" << info.language << " timescale=" << info.timescale << '\n';
        }
    }

    void onAccessUnit(tlvdemux::AccessUnit&& unit) override {
        const auto track = tracks.find(unit.track_id);
        if (trace) {
            std::cerr << "au offset=" << unit.input_offset << " track=" << unit.track_id;
            if (track != tracks.end()) {
                std::cerr << " context=" << track->second.context_id
                          << " packet-id=0x" << std::hex << track->second.packet_id << std::dec;
            }
            std::cerr << " codec=" << codec_name(unit.codec) << " size=" << unit.data.size()
                      << " pts=" << unit.pts.value << '/' << unit.pts.timescale
                      << " dts=" << unit.dts.value << '/' << unit.dts.timescale
                      << " rap=" << unit.random_access
                      << " discontinuity=" << unit.discontinuity << '\n';
        }
        std::ofstream* output = nullptr;
        if (unit.codec == tlvdemux::Codec::Hevc && video_track == unit.track_id) output = &video;
        if (unit.codec == tlvdemux::Codec::AacLatm && audio_track == unit.track_id) output = &audio;
        if (unit.codec == tlvdemux::Codec::Ttml && subtitle_track == unit.track_id) output = &subtitle;
        if (output != nullptr && output->is_open()) {
            output->write(reinterpret_cast<const char*>(unit.data.data()),
                          static_cast<std::streamsize>(unit.data.size()));
        }
    }

    void onError(const tlvdemux::Error& error) override {
        std::cerr << error_name(error.code) << " offset=" << error.input_offset
                  << " recoverable=" << error.recoverable << ": " << error.message << '\n';
    }
};

void usage() {
    std::cerr << "usage: tlvdemux-inspect [--list] [--trace-au] [--service ID]"
                 " [--video FILE] [--audio FILE] [--subtitle FILE] INPUT\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        Inspector inspector;
        std::optional<std::uint32_t> service;
        std::string input_path;

        for (int index = 1; index < argc; ++index) {
            const std::string argument = argv[index];
            auto value = [&](const char* option) -> std::string {
                if (++index >= argc) throw std::runtime_error(std::string("missing value for ") + option);
                return argv[index];
            };
            if (argument == "--list") inspector.list = true;
            else if (argument == "--trace-au") inspector.trace = true;
            else if (argument == "--service") service = static_cast<std::uint32_t>(std::stoul(value("--service"), nullptr, 0));
            else if (argument == "--video") {
                const auto path = value("--video");
                inspector.video.open(path, std::ios::binary);
                if (!inspector.video) throw std::runtime_error("cannot open video output: " + path);
            } else if (argument == "--audio") {
                const auto path = value("--audio");
                inspector.audio.open(path, std::ios::binary);
                if (!inspector.audio) throw std::runtime_error("cannot open audio output: " + path);
            } else if (argument == "--subtitle") {
                const auto path = value("--subtitle");
                inspector.subtitle.open(path, std::ios::binary);
                if (!inspector.subtitle) throw std::runtime_error("cannot open subtitle output: " + path);
            }
            else if (argument == "-h" || argument == "--help") { usage(); return 0; }
            else if (!argument.empty() && argument[0] == '-' && argument != "-") throw std::runtime_error("unknown option: " + argument);
            else if (input_path.empty()) input_path = argument;
            else throw std::runtime_error("more than one input path was provided");
        }
        if (input_path.empty()) {
            usage();
            return 2;
        }
        if (!inspector.list && !inspector.trace && !inspector.video.is_open() &&
            !inspector.audio.is_open() && !inspector.subtitle.is_open()) {
            inspector.list = true;
        }

        std::ifstream file;
        std::istream* input = &std::cin;
        if (input_path != "-") {
            file.open(input_path, std::ios::binary);
            if (!file) throw std::runtime_error("cannot open input: " + input_path);
            input = &file;
        }

        tlvdemux::Demuxer demuxer(inspector);
        demuxer.selectService(service);
        std::array<std::uint8_t, 64 * 1024> buffer{};
        while (*input) {
            input->read(reinterpret_cast<char*>(buffer.data()),
                        static_cast<std::streamsize>(buffer.size()));
            const auto count = input->gcount();
            if (count > 0) demuxer.push(buffer.data(), static_cast<std::size_t>(count));
        }
        demuxer.flush();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "tlvdemux-inspect: " << error.what() << '\n';
        return 2;
    }
}
