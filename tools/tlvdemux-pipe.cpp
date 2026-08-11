#include <aribtlv/demuxer.hpp>
#include <tlvdemux/mse_remuxer.hpp>

#include <array>
#include <cerrno>
#include <csignal>
#include <cstdint>
#include <exception>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

class ConsumerClosed final : public std::exception {};

class PipeSink final : public aribtlv::Sink, public tlvdemux::MseSink {
public:
    PipeSink(std::optional<std::uint16_t> video_packet_id,
             std::optional<std::uint16_t> audio_packet_id, const bool video_only)
        : video_packet_id_(video_packet_id), audio_packet_id_(audio_packet_id),
          video_only_(video_only),
          remuxer_(*this, {0, video_only ? tlvdemux::MseOutputMode::SeparateTracks
                                        : tlvdemux::MseOutputMode::Multiplexed}) {}

    void onService(const aribtlv::ServiceInfo&) override {}

    void onTrack(const aribtlv::TrackInfo& track) override {
        if (track.kind == aribtlv::TrackKind::Video && !video_track_ &&
            (!video_packet_id_ || track.packet_id == *video_packet_id_)) {
            video_track_ = track.track_id;
            remuxer_.selectTrack(aribtlv::TrackKind::Video, video_track_);
        } else if (!video_only_ && track.kind == aribtlv::TrackKind::Audio && !audio_track_ &&
                   (!audio_packet_id_ || track.packet_id == *audio_packet_id_)) {
            audio_track_ = track.track_id;
            remuxer_.selectTrack(aribtlv::TrackKind::Audio, audio_track_);
        }
    }

    void onAccessUnit(aribtlv::AccessUnit&& unit) override { remuxer_.push(unit); }

    void onError(const aribtlv::Error& error) override {
        if (!error.recoverable) throw std::runtime_error(error.message);
        std::cerr << "recoverable error at " << error.input_offset << ": "
                  << error.message << '\n';
    }

    void onMseInit(tlvdemux::MseTrackInit&& init) override {
        write(init.data);
        initialized_ = true;
    }

    void onMseSegment(tlvdemux::MseMediaSegment&& segment) override {
        write(segment.data);
    }

    void flush() {
        remuxer_.flush();
        if (!video_track_) throw std::runtime_error("no matching video track was discovered");
        if (!video_only_ && !audio_track_) {
            throw std::runtime_error("no matching audio track was discovered");
        }
        if (!initialized_) {
            throw std::runtime_error(video_only_ ? "video codec configuration was incomplete"
                                                 : "video/audio codec configuration was incomplete");
        }
    }

private:
    static void write(const std::vector<std::uint8_t>& data) {
        errno = 0;
        std::cout.write(reinterpret_cast<const char*>(data.data()),
                        static_cast<std::streamsize>(data.size()));
        std::cout.flush();
        if (!std::cout && errno == EPIPE) throw ConsumerClosed{};
        if (!std::cout) throw std::runtime_error("cannot write fragmented MP4 to stdout");
    }

    std::optional<std::uint16_t> video_packet_id_;
    std::optional<std::uint16_t> audio_packet_id_;
    bool video_only_ = false;
    std::optional<std::uint64_t> video_track_;
    std::optional<std::uint64_t> audio_track_;
    bool initialized_ = false;
    tlvdemux::MseRemuxer remuxer_;
};

std::uint16_t packet_id(const std::string& value) {
    const auto parsed = std::stoul(value, nullptr, 0);
    if (parsed > 0xffffU) throw std::runtime_error("packet ID is outside the 16-bit range");
    return static_cast<std::uint16_t>(parsed);
}

void usage() {
    std::cerr << "usage: tlvdemux-pipe [--video-only] [--service ID] [--video-packet-id ID]"
                 " [--audio-packet-id ID] INPUT|-\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        std::optional<std::uint32_t> service;
        std::optional<std::uint16_t> video_packet_id;
        std::optional<std::uint16_t> audio_packet_id;
        bool video_only = false;
        std::string input_path;
        for (int index = 1; index < argc; ++index) {
            const std::string argument = argv[index];
            auto value = [&](const char* option) -> std::string {
                if (++index >= argc) {
                    throw std::runtime_error(std::string("missing value for ") + option);
                }
                return argv[index];
            };
            if (argument == "--video-only") {
                video_only = true;
            } else if (argument == "--service") {
                service = static_cast<std::uint32_t>(std::stoul(value("--service"), nullptr, 0));
            } else if (argument == "--video-packet-id") {
                video_packet_id = packet_id(value("--video-packet-id"));
            } else if (argument == "--audio-packet-id") {
                audio_packet_id = packet_id(value("--audio-packet-id"));
            } else if (argument == "-h" || argument == "--help") {
                usage();
                return 0;
            } else if (!argument.empty() && argument[0] == '-' && argument != "-") {
                throw std::runtime_error("unknown option: " + argument);
            } else if (input_path.empty()) {
                input_path = argument;
            } else {
                throw std::runtime_error("more than one input path was provided");
            }
        }
        if (input_path.empty()) {
            usage();
            return 2;
        }
        if (video_only && audio_packet_id) {
            throw std::runtime_error("--audio-packet-id cannot be used with --video-only");
        }

#ifndef _WIN32
        // A finite FFmpeg consumer can intentionally close its stdin after it
        // has decoded the requested frames. Convert that normal pipe shutdown
        // into ConsumerClosed instead of letting SIGPIPE terminate this process.
        std::signal(SIGPIPE, SIG_IGN);
#endif

#ifdef _WIN32
        if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
            throw std::runtime_error("cannot set stdout to binary mode");
        }
        if (input_path == "-" && _setmode(_fileno(stdin), _O_BINARY) == -1) {
            throw std::runtime_error("cannot set stdin to binary mode");
        }
#endif

        PipeSink sink(video_packet_id, audio_packet_id, video_only);
        aribtlv::Demuxer demuxer(sink);
        demuxer.selectService(service);

        std::ifstream file;
        std::istream* input = &std::cin;
        if (input_path != "-") {
            file.open(input_path, std::ios::binary);
            if (!file) throw std::runtime_error("cannot open input: " + input_path);
            input = &file;
        }

        std::array<std::uint8_t, 64 * 1024> buffer{};
        while (*input) {
            input->read(reinterpret_cast<char*>(buffer.data()),
                        static_cast<std::streamsize>(buffer.size()));
            const auto count = input->gcount();
            if (count > 0) demuxer.push(buffer.data(), static_cast<std::size_t>(count));
        }
        if (!input->eof()) throw std::runtime_error("cannot read input");
        demuxer.flush();
        sink.flush();
        return 0;
    } catch (const ConsumerClosed&) {
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "tlvdemux-pipe: " << error.what() << '\n';
        return 2;
    }
}
