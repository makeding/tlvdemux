cmake_minimum_required(VERSION 3.16)

project(tlvdemux VERSION 0.1.8 LANGUAGES CXX)

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
    "ff1260c0e05b183731f630a0aecd7d06fc112155" CACHE STRING
    "Pinned libaribtlv Git revision")
mark_as_advanced(
    TLVDEMUX_LIBARIBTLV_GIT_REPOSITORY
    TLVDEMUX_LIBARIBTLV_GIT_TAG)

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

add_library(tlvdemux
    src/mse/hevc_parser.cpp
    src/mse/latm_parser.cpp
    src/mse/mp4_builder.cpp
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
    add_executable(tlvdemux-inspect tools/tlvdemux-inspect.cpp)
    target_link_libraries(tlvdemux-inspect PRIVATE aribtlv::aribtlv)
    add_executable(tlvdemux-cocktail tools/tlvdemux-cocktail.cpp)
    target_link_libraries(tlvdemux-cocktail PRIVATE tlvdemux::tlvdemux)
    add_executable(tlvdemux-extract tools/tlvdemux-extract.cpp)
    target_link_libraries(tlvdemux-extract PRIVATE aribtlv::aribtlv)
    add_executable(tlvdemux-probe tools/tlvdemux-probe.cpp)
    target_link_libraries(tlvdemux-probe PRIVATE aribtlv::aribtlv)
    add_executable(tlvanalyze tools/tlvanalyze.cpp)
    target_link_libraries(tlvanalyze PRIVATE aribtlv::aribtlv)
    if(APPLE)
        add_executable(tlvdemux-videotoolbox-probe tools/tlvdemux-videotoolbox-probe.cpp)
        target_link_libraries(tlvdemux-videotoolbox-probe PRIVATE
            tlvdemux::tlvdemux
            "-framework CoreFoundation"
            "-framework CoreMedia"
            "-framework CoreVideo"
            "-framework VideoToolbox"
        )
        target_compile_options(tlvdemux-videotoolbox-probe PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    if(MSVC)
        target_compile_options(tlvdemux-inspect PRIVATE /W4 /permissive-)
        target_compile_options(tlvdemux-cocktail PRIVATE /W4 /permissive-)
        target_compile_options(tlvdemux-extract PRIVATE /W4 /permissive-)
        target_compile_options(tlvdemux-probe PRIVATE /W4 /permissive-)
        target_compile_options(tlvanalyze PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-inspect PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(tlvdemux-cocktail PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(tlvdemux-extract PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(tlvdemux-probe PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(tlvanalyze PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    install(TARGETS tlvdemux-inspect tlvdemux-extract tlvdemux-probe tlvanalyze
            RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
    if(APPLE)
        install(TARGETS tlvdemux-videotoolbox-probe
                RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
    endif()
endif()

if(TLVDEMUX_BUILD_WASM_BINDINGS)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR "TLVDEMUX_BUILD_WASM_BINDINGS requires the Emscripten toolchain")
    endif()

    add_executable(tlvdemux-wasm wasm/bindings.cpp)
    target_link_libraries(tlvdemux-wasm PRIVATE tlvdemux::tlvdemux)
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
    add_executable(tlvdemux-playback-tests tests/playback_tests.cpp)
    target_link_libraries(tlvdemux-playback-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-playback-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-playback-tests PRIVATE
            -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-playback-tests COMMAND tlvdemux-playback-tests)

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
