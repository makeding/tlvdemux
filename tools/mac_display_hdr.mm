#include "mac_display_hdr.hpp"

#import <AppKit/AppKit.h>

#include <ostream>

namespace tlvdemux::tools {

void log_mac_display_hdr(std::ostream& diagnostics) {
    @autoreleasepool {
        const auto screens = NSScreen.screens;
        diagnostics << "mac-displays=" << screens.count << '\n';
        for (NSUInteger index = 0; index < screens.count; ++index) {
            NSScreen* screen = screens[index];
            NSString* name = screen.localizedName;
            NSString* color_space = screen.colorSpace.localizedName;
            diagnostics << "mac-display index=" << index
                        << " name=" << (name != nil ? name.UTF8String : "unknown")
                        << " color-space="
                        << (color_space != nil ? color_space.UTF8String : "unknown")
                        << " edr-current="
                        << screen.maximumExtendedDynamicRangeColorComponentValue
                        << " edr-potential="
                        << screen.maximumPotentialExtendedDynamicRangeColorComponentValue
                        << " edr-reference="
                        << screen.maximumReferenceExtendedDynamicRangeColorComponentValue
                        << '\n';
        }
    }
}

} // namespace tlvdemux::tools
