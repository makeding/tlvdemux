cmake_minimum_required(VERSION 3.16)

project(tlvdemux VERSION 0.3.3 LANGUAGES CXX)

set(TLVDEMUX_RELEASE_VERSION "0.3.3")

include(CTest)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

option(BUILD_SHARED_LIBS "Build libtlvdemux as a shared library" ON)
option(TLVDEMUX_BUILD_TOOLS "Build tlvdemux command-line tools" ON)
option(TLVDEMUX_BUILD_WASM_BINDINGS "Build the Emscripten JavaScript/WASM wrapper" ${EMSCRIPTEN})
option(TLVDEMUX_USE_SYSTEM_LIBARIBTLV
    "Use an installed libaribtlv package instead of the pinned Git revision" OFF)
set(TLVDEMUX_LIBARIBTLV_SOURCE_DIR "" CACHE PATH
    "Path to a local libaribtlv source checkout (overrides Git/system selection)")
set(TLVDEMUX_LIBARIBTLV_GIT_REPOSITORY
    "https://github.com/makeding/libaribtlv.git" CACHE STRING
    "Git repository used to fetch libaribtlv")
set(TLVDEMUX_LIBARIBTLV_GIT_TAG
    "6ecf9e3b1a8fd95563bc5071213b67b936ea01b3" CACHE STRING
    "Pinned libaribtlv Git revision")
mark_as_advanced(
    TLVDEMUX_LIBARIBTLV_GIT_REPOSITORY
    TLVDEMUX_LIBARIBTLV_GIT_TAG)

# BUILD_TESTING belongs to this top-level project.  A source dependency may use
# the same CTest option, so hide it while adding libaribtlv and restore it before
# declaring tlvdemux's own tests below.
set(_TLVDEMUX_BUILD_TESTING "${BUILD_TESTING}")
set(BUILD_TESTING OFF)

if(TLVDEMUX_LIBARIBTLV_SOURCE_DIR)
    if(NOT EXISTS "${TLVDEMUX_LIBARIBTLV_SOURCE_DIR}/CMakeLists.txt")
        message(FATAL_ERROR
            "TLVDEMUX_LIBARIBTLV_SOURCE_DIR does not contain CMakeLists.txt: "
            "${TLVDEMUX_LIBARIBTLV_SOURCE_DIR}")
    endif()
    add_subdirectory("${TLVDEMUX_LIBARIBTLV_SOURCE_DIR}"
                     "${CMAKE_CURRENT_BINARY_DIR}/libaribtlv")
elseif(TLVDEMUX_USE_SYSTEM_LIBARIBTLV)
    find_package(aribtlv CONFIG REQUIRED)
else()
    include(FetchContent)
    FetchContent_Declare(libaribtlv
        GIT_REPOSITORY "${TLVDEMUX_LIBARIBTLV_GIT_REPOSITORY}"
        GIT_TAG "${TLVDEMUX_LIBARIBTLV_GIT_TAG}"
        GIT_PROGRESS TRUE
    )
    FetchContent_MakeAvailable(libaribtlv)
endif()

set(BUILD_TESTING "${_TLVDEMUX_BUILD_TESTING}")
unset(_TLVDEMUX_BUILD_TESTING)

if(TARGET aribtlv-timestamp-mpu-tests)
    message(FATAL_ERROR
        "libaribtlv repository-internal tests leaked into the tlvdemux build")
endif()

add_library(tlvdemux
    src/hevc_metadata.cpp
    src/playback_damage.cpp
    src/playback_timing.cpp
    src/mse/chromium_coded_frame_policy.cpp
    src/mse/hevc_parser.cpp
    src/mse/latm_parser.cpp
    src/mse/mp4_builder.cpp
    src/mse/output_capabilities.cpp
    src/mse/output_format.cpp
    src/mse/output_state.cpp
    src/mse/video_access_unit_history.cpp
    src/mse/video_layer_state_machine.cpp
    wasm/mse_remuxer.cpp
    src/playback.cpp
)
add_library(tlvdemux::tlvdemux ALIAS tlvdemux)

set_target_properties(tlvdemux PROPERTIES
    CXX_EXTENSIONS OFF
    OUTPUT_NAME tlvdemux
    VERSION ${PROJECT_VERSION}
    SOVERSION ${PROJECT_VERSION_MAJOR}
)

target_compile_features(tlvdemux PUBLIC cxx_std_20)
target_link_libraries(tlvdemux PUBLIC aribtlv::aribtlv)
target_include_directories(tlvdemux
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(MSVC)
    target_compile_options(tlvdemux PRIVATE /W4 /permissive-)
else()
    target_compile_options(tlvdemux PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

install(TARGETS tlvdemux
    EXPORT tlvdemuxTargets
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(FILES LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/licenses/tlvdemux)
install(EXPORT tlvdemuxTargets
    FILE tlvdemuxTargets.cmake
    NAMESPACE tlvdemux::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tlvdemux
)
configure_package_config_file(
    cmake/tlvdemuxConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/tlvdemuxConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tlvdemux
)
write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/tlvdemuxConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion
)
install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/tlvdemuxConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/tlvdemuxConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tlvdemux
)

if(TLVDEMUX_BUILD_TOOLS)
    add_executable(tlvdemux-cli
        tools/tlvdemux.cpp
        tools/tlvdemux-hlg-sdr-lut.cpp
        tools/tlvdemux-inspect.cpp
        tools/tlvdemux-extract.cpp
        tools/tlvdemux-probe.cpp
        tools/tlvdemux-calcseek.cpp
        tools/calcseek_time.cpp
        tools/tlvdemux-pipe.cpp
        tools/tlvanalyze.cpp
        tools/recording_time_seek.cpp
    )
    target_link_libraries(tlvdemux-cli PRIVATE tlvdemux::tlvdemux)
    target_compile_definitions(tlvdemux-cli PRIVATE
        TLVDEMUX_VERSION="${TLVDEMUX_RELEASE_VERSION}")
    set_target_properties(tlvdemux-cli PROPERTIES OUTPUT_NAME tlvdemux)
    add_executable(tlvdemux-cocktail tools/tlvdemux-cocktail.cpp)
    target_link_libraries(tlvdemux-cocktail PRIVATE tlvdemux::tlvdemux)
    if(APPLE)
        enable_language(OBJCXX)
        add_executable(tlvdemux-videotoolbox-probe
            tools/tlvdemux-videotoolbox-probe.cpp
            tools/videotoolbox_probe_main.cpp
            tools/mac_display_hdr.mm
            tools/recording_time_seek.cpp
            tools/videotoolbox_probe_parsing.cpp
        )
        target_link_libraries(tlvdemux-videotoolbox-probe PRIVATE
            tlvdemux::tlvdemux
            "-framework CoreFoundation"
            "-framework CoreMedia"
            "-framework CoreVideo"
            "-framework AppKit"
            "-framework VideoToolbox"
        )
        target_include_directories(tlvdemux-videotoolbox-probe PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/src)
        target_compile_options(tlvdemux-videotoolbox-probe PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    if(MSVC)
        target_compile_options(tlvdemux-cli PRIVATE /W4 /permissive-)
        target_compile_options(tlvdemux-cocktail PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-cli PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(tlvdemux-cocktail PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    install(TARGETS tlvdemux-cli
            RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

if(TLVDEMUX_BUILD_WASM_BINDINGS)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR "TLVDEMUX_BUILD_WASM_BINDINGS requires the Emscripten toolchain")
    endif()

    add_executable(tlvdemux-wasm
        wasm/bindings.cpp
        wasm/mse_remuxer_bindings.cpp
    )
    target_link_libraries(tlvdemux-wasm PRIVATE tlvdemux::tlvdemux)
    target_include_directories(tlvdemux-wasm PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_link_options(tlvdemux-wasm PRIVATE
        --bind
        "-sALLOW_MEMORY_GROWTH=1"
        "-sGROWABLE_ARRAYBUFFERS=0"
        "-sENVIRONMENT=web,worker,node"
        "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
        "-sEXPORT_NAME=createTlvDemuxModule"
        "-sFILESYSTEM=0"
        "-sMODULARIZE=1"
        "-sNO_EXIT_RUNTIME=1"
        "-sSINGLE_FILE=1"
        "-sWASM_BIGINT=1"
    )
    set_target_properties(tlvdemux-wasm PROPERTIES
        OUTPUT_NAME tlvdemux
        SUFFIX ".js"
    )

    install(PROGRAMS
        ${CMAKE_CURRENT_BINARY_DIR}/tlvdemux.js
        DESTINATION ${CMAKE_INSTALL_DATADIR}/tlvdemux/wasm
    )
endif()

if(BUILD_TESTING)
    if(TLVDEMUX_BUILD_TOOLS)
        add_test(NAME tlvdemux-cli-help COMMAND tlvdemux-cli --help)
        add_test(NAME tlvdemux-cli-version COMMAND tlvdemux-cli --version)
        foreach(command hlg-sdr-lut pipe probe calcseek inspect extract analyze)
            add_test(NAME tlvdemux-cli-${command}-help
                     COMMAND tlvdemux-cli ${command} --help)
        endforeach()
        add_test(NAME tlvdemux-cli-hlg-sdr-lut-output
                 COMMAND tlvdemux-cli hlg-sdr-lut)
        set_tests_properties(tlvdemux-cli-hlg-sdr-lut-output PROPERTIES
            PASS_REGULAR_EXPRESSION "LUT_3D_SIZE 33")
        add_test(NAME tlvdemux-cli-hlg-sdr-prototype-lut-output
                 COMMAND tlvdemux-cli hlg-sdr-lut --prototype)
        set_tests_properties(tlvdemux-cli-hlg-sdr-prototype-lut-output PROPERTIES
            PASS_REGULAR_EXPRESSION "TITLE \"tlvdemux HLG-SDR prototype\"")
        add_test(NAME tlvdemux-cli-missing-command COMMAND tlvdemux-cli)
        set_tests_properties(tlvdemux-cli-missing-command PROPERTIES WILL_FAIL TRUE)
        add_test(NAME tlvdemux-cli-unknown-command COMMAND tlvdemux-cli unknown)
        set_tests_properties(tlvdemux-cli-unknown-command PROPERTIES WILL_FAIL TRUE)
    endif()

    add_executable(tlvdemux-calcseek-time-tests
        tests/calcseek_time_tests.cpp
        tools/calcseek_time.cpp)
    target_include_directories(tlvdemux-calcseek-time-tests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/tools)
    target_compile_features(tlvdemux-calcseek-time-tests PRIVATE cxx_std_20)
    if(MSVC)
        target_compile_options(tlvdemux-calcseek-time-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-calcseek-time-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-calcseek-time-tests
        COMMAND tlvdemux-calcseek-time-tests)

    add_executable(tlvdemux-playback-tests tests/playback_tests.cpp)
    target_link_libraries(tlvdemux-playback-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-playback-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-playback-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-playback-tests COMMAND tlvdemux-playback-tests)

    add_executable(tlvdemux-playback-damage-tests
        tests/playback_damage_tests.cpp)
    target_link_libraries(tlvdemux-playback-damage-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-playback-damage-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-playback-damage-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-playback-damage-tests
        COMMAND tlvdemux-playback-damage-tests)

    add_executable(tlvdemux-package-api-tests tests/package/main.cpp)
    target_link_libraries(tlvdemux-package-api-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-package-api-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-package-api-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-package-api-tests COMMAND tlvdemux-package-api-tests)

    add_executable(tlvdemux-mse-remuxer-tests tests/mse_remuxer_tests.cpp)
    target_link_libraries(tlvdemux-mse-remuxer-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-mse-remuxer-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-mse-remuxer-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-mse-remuxer-tests COMMAND tlvdemux-mse-remuxer-tests)

    add_executable(tlvdemux-timestamp-fmp4-tests tests/timestamp_fmp4_tests.cpp)
    target_link_libraries(tlvdemux-timestamp-fmp4-tests PRIVATE tlvdemux::tlvdemux)
    target_include_directories(tlvdemux-timestamp-fmp4-tests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    if(MSVC)
        target_compile_options(tlvdemux-timestamp-fmp4-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-timestamp-fmp4-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-timestamp-fmp4-tests
        COMMAND tlvdemux-timestamp-fmp4-tests)

    add_executable(tlvdemux-video-layer-state-tests
        tests/video_layer_state_machine_tests.cpp)
    target_link_libraries(tlvdemux-video-layer-state-tests PRIVATE tlvdemux::tlvdemux)
    target_include_directories(tlvdemux-video-layer-state-tests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    if(MSVC)
        target_compile_options(tlvdemux-video-layer-state-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-video-layer-state-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-video-layer-state-tests
        COMMAND tlvdemux-video-layer-state-tests)

    add_executable(tlvdemux-chromium-coded-frame-policy-tests
        tests/chromium_coded_frame_policy_tests.cpp)
    target_link_libraries(tlvdemux-chromium-coded-frame-policy-tests PRIVATE
        tlvdemux::tlvdemux)
    target_include_directories(tlvdemux-chromium-coded-frame-policy-tests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    if(MSVC)
        target_compile_options(tlvdemux-chromium-coded-frame-policy-tests PRIVATE
            /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-chromium-coded-frame-policy-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-chromium-coded-frame-policy-tests
        COMMAND tlvdemux-chromium-coded-frame-policy-tests)

    add_executable(tlvdemux-hlg-sdr-tone-mapping-tests
        tests/hlg_sdr_tone_mapping_tests.cpp)
    target_link_libraries(tlvdemux-hlg-sdr-tone-mapping-tests PRIVATE
        tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-hlg-sdr-tone-mapping-tests PRIVATE
            /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-hlg-sdr-tone-mapping-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-hlg-sdr-tone-mapping-tests
        COMMAND tlvdemux-hlg-sdr-tone-mapping-tests)

    add_executable(tlvdemux-presentation-policy-tests
        tests/presentation_policy_tests.cpp)
    target_link_libraries(tlvdemux-presentation-policy-tests
        PRIVATE tlvdemux::tlvdemux)
    target_include_directories(tlvdemux-presentation-policy-tests
        PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    add_test(NAME tlvdemux-presentation-policy-tests
        COMMAND tlvdemux-presentation-policy-tests)

    add_executable(tlvdemux-output-capabilities-tests
        tests/output_capabilities_tests.cpp)
    target_link_libraries(tlvdemux-output-capabilities-tests
        PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-output-capabilities-tests PRIVATE
            /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-output-capabilities-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-output-capabilities-tests
        COMMAND tlvdemux-output-capabilities-tests)

    add_executable(tlvdemux-output-state-tests tests/output_state_tests.cpp)
    target_link_libraries(tlvdemux-output-state-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-output-state-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-output-state-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-output-state-tests COMMAND tlvdemux-output-state-tests)

    add_executable(tlvdemux-output-format-tests tests/output_format_tests.cpp)
    target_link_libraries(tlvdemux-output-format-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-output-format-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-output-format-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-output-format-tests COMMAND tlvdemux-output-format-tests)

    add_executable(tlvdemux-playback-timing-tests tests/playback_timing_tests.cpp)
    target_link_libraries(tlvdemux-playback-timing-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-playback-timing-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-playback-timing-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-playback-timing-tests
        COMMAND tlvdemux-playback-timing-tests)

    if(TLVDEMUX_BUILD_WASM_BINDINGS)
        find_program(NODE_EXECUTABLE node)
        if(NODE_EXECUTABLE)
            add_test(
                NAME tlvdemux-hlg-sdr-lut
                COMMAND ${NODE_EXECUTABLE}
                        ${CMAKE_CURRENT_SOURCE_DIR}/tests/hlg_sdr_lut.mjs
                        $<TARGET_FILE:tlvdemux-wasm>)
        endif()
    endif()

    if(TLVDEMUX_BUILD_WASM_BINDINGS)
        find_program(NODE_EXECUTABLE node)
        if(NODE_EXECUTABLE)
            add_test(
                NAME tlvdemux-wasm-smoke
                COMMAND ${NODE_EXECUTABLE}
                        ${CMAKE_CURRENT_SOURCE_DIR}/tests/wasm_smoke.mjs
                        $<TARGET_FILE:tlvdemux-wasm>
            )
        endif()
    endif()
endif()
