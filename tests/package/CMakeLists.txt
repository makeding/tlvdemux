cmake_minimum_required(VERSION 3.16)
project(tlvdemux-package-consumer LANGUAGES CXX)

find_package(tlvdemux CONFIG REQUIRED)

add_executable(tlvdemux-package-consumer main.cpp)
target_link_libraries(tlvdemux-package-consumer PRIVATE tlvdemux::tlvdemux)

