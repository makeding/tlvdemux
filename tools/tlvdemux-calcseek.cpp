#include "calcseek_time.hpp"
#include "commands.hpp"
#include "recording_time_seek.hpp"

#include <iomanip>
#include <iostream>
#include <string>

namespace {

void usage(std::ostream& output) {
    output << "usage: tlvdemux calcseek INPUT\n"
              "\n"
              "After indexing INPUT, enter seconds, MM:SS, or HH:MM:SS on stdin.\n"
              "Enter q, quit, or exit to leave interactive mode.\n";
}

bool is_exit_command(const std::string& line) {
    return line == "q" || line == "quit" || line == "exit";
}

} // namespace

int tlvdemux_cli::run_calcseek(const int argc, char** argv) {
    try {
        if (argc == 2 && (std::string(argv[1]) == "-h" ||
                          std::string(argv[1]) == "--help")) {
            usage(std::cout);
            return 0;
        }
        if (argc != 2) {
            usage(std::cerr);
            return 2;
        }

        std::cerr << "calcseek: indexing " << argv[1] << "\n";
        const auto index = tlvdemux::tools::build_recording_time_seek_index(
            argv[1], std::cerr);
        std::cerr << "calcseek: ready seek-points=" << index.seek_point_count << '\n';

        std::string line;
        while (true) {
            std::cerr << "calcseek> " << std::flush;
            if (!std::getline(std::cin, line)) {
                std::cerr << '\n';
                break;
            }
            if (is_exit_command(line)) break;

            const auto seconds = tlvdemux::tools::parse_calcseek_time(line);
            if (!seconds) {
                std::cerr << "calcseek: invalid time; use seconds, MM:SS, or HH:MM:SS\n";
                continue;
            }
            try {
                const auto result = tlvdemux::tools::locate_recording_time(index, *seconds);
                std::cout << std::fixed << std::setprecision(6)
                          << "target-seconds=" << *seconds
                          << " target-pts-us=" << result.target_pts_us
                          << " sync-pts-us=" << result.point.presentation_time.value
                          << " offset=" << result.point.signalling_offset
                          << " signalling-offset=" << result.point.signalling_offset
                          << " random-access-offset=" << result.point.random_access_offset
                          << '\n';
            } catch (const std::exception& error) {
                std::cerr << "calcseek: " << error.what() << '\n';
            }
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "tlvdemux calcseek: " << error.what() << '\n';
        return 2;
    }
}
