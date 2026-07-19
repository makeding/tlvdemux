cmake_minimum_required(VERSION 3.16)

project(tlvdemux VERSION 0.1.0 LANGUAGES CXX)

include(CTest)

add_library(tlvdemux
    src/compressed_ip_parser.cpp
    src/demuxer.cpp
    src/mmtp_parser.cpp
    src/tlv_parser.cpp
)
add_library(tlvdemux::tlvdemux ALIAS tlvdemux)

target_compile_features(tlvdemux PUBLIC cxx_std_17)
target_include_directories(tlvdemux
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(MSVC)
    target_compile_options(tlvdemux PRIVATE /W4 /permissive-)
else()
    target_compile_options(tlvdemux PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

add_executable(tlvdemux-inspect tools/tlvdemux-inspect.cpp)
target_link_libraries(tlvdemux-inspect PRIVATE tlvdemux::tlvdemux)
if(MSVC)
    target_compile_options(tlvdemux-inspect PRIVATE /W4 /permissive-)
else()
    target_compile_options(tlvdemux-inspect PRIVATE -Wall -Wextra -Wpedantic)
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

