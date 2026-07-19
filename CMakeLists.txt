cmake_minimum_required(VERSION 3.16)

project(tlvdemux VERSION 0.1.0 LANGUAGES CXX)

include(CTest)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

option(BUILD_SHARED_LIBS "Build libtlvdemux as a shared library" ON)
option(TLVDEMUX_BUILD_TOOLS "Build tlvdemux command-line tools" ON)

add_library(tlvdemux
    src/compressed_ip_parser.cpp
    src/demuxer.cpp
    src/mmtp_parser.cpp
    src/tlv_parser.cpp
)
add_library(tlvdemux::tlvdemux ALIAS tlvdemux)

set_target_properties(tlvdemux PROPERTIES
    OUTPUT_NAME tlvdemux
    VERSION ${PROJECT_VERSION}
    SOVERSION ${PROJECT_VERSION_MAJOR}
)

target_compile_features(tlvdemux PUBLIC cxx_std_17)
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
    target_link_libraries(tlvdemux-inspect PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-inspect PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-inspect PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    install(TARGETS tlvdemux-inspect RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

if(BUILD_TESTING)
    add_executable(tlvdemux-tests tests/demuxer_tests.cpp)
    target_link_libraries(tlvdemux-tests PRIVATE tlvdemux::tlvdemux)
    if(MSVC)
        target_compile_options(tlvdemux-tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(tlvdemux-tests PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME tlvdemux-tests COMMAND tlvdemux-tests)
endif()
