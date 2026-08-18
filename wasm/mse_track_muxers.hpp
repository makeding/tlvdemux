#pragma once

#include <tlvdemux/mse_remuxer.hpp>

#include <aribtlv/video_color.hpp>

#include "mse/hevc_parser.hpp"
#include "mse/latm_parser.hpp"
#include "mse/mp4_builder.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace tlvdemux::detail::mse::remux {

using tlvdemux::detail::mse::Bytes;
using tlvdemux::detail::mse::ColorInformation;
using tlvdemux::detail::mse::HevcConfiguration;
using tlvdemux::detail::mse::LatmParser;
using tlvdemux::detail::mse::Mp4Track;
using tlvdemux::detail::mse::NaluView;
using tlvdemux::detail::mse::Sample;
using tlvdemux::detail::mse::annex_b_views;
using tlvdemux::detail::mse::append;
using tlvdemux::detail::mse::copy_nalu;
using tlvdemux::detail::mse::hevc_configuration;
using tlvdemux::detail::mse::init_segment;
using tlvdemux::detail::mse::media_segment;
using tlvdemux::detail::mse::scaled;

#include "mse_track_muxer_base.hpp"
#include "mse_hevc_muxer.hpp"
#include "mse_aac_muxer.hpp"

} // namespace tlvdemux::detail::mse::remux

