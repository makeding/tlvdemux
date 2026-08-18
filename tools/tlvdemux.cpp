#include "commands.hpp"

#include <iostream>
#include <string>

#ifndef TLVDEMUX_VERSION
#define TLVDEMUX_VERSION "unknown"
#endif

namespace {

void usage(std::ostream& output) {
    output << "tlvdemux by huggy version " TLVDEMUX_VERSION "\n"
              "\n"
              "usage: tlvdemux <command> [options]\n"
              "\n"
              "commands:\n"
              "  hlg-sdr-lut  export the current HLG-to-SDR 3D LUT as .cube\n"
              "  pipe     remux HEVC and AAC-LATM to fragmented MP4 on stdout\n"
              "  probe    determine the physical duration of a recording\n"
              "  calcseek calculate recording seek offsets interactively\n"
              "  inspect  list tracks or extract elementary streams\n"
              "  extract  extract ARIB-HTML5 application resources\n"
              "  analyze  analyze ARIB-HTML5 application resources\n"
              "\n"
              "run 'tlvdemux <command> --help' for command-specific usage\n";
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage(std::cerr);
        return 2;
    }

    const std::string command = argv[1];
    if (command == "-h" || command == "--help") {
        usage(std::cout);
        return 0;
    }
    if (command == "-V" || command == "--version") {
        std::cout << "tlvdemux by huggy version " << TLVDEMUX_VERSION << '\n';
        return 0;
    }
    if (command == "pipe") return tlvdemux_cli::run_pipe(argc - 1, argv + 1);
    if (command == "hlg-sdr-lut") {
        return tlvdemux_cli::run_hlg_sdr_lut(argc - 1, argv + 1);
    }
    if (command == "probe") return tlvdemux_cli::run_probe(argc - 1, argv + 1);
    if (command == "calcseek") return tlvdemux_cli::run_calcseek(argc - 1, argv + 1);
    if (command == "inspect") return tlvdemux_cli::run_inspect(argc - 1, argv + 1);
    if (command == "extract") return tlvdemux_cli::run_extract(argc - 1, argv + 1);
    if (command == "analyze") return tlvdemux_cli::run_analyze(argc - 1, argv + 1);

    std::cerr << "tlvdemux: unknown command: " << command << '\n';
    usage(std::cerr);
    return 2;
}
