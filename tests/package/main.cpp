#include <tlvdemux/playback.hpp>
#include <tlvdemux/mse_remuxer.hpp>

namespace {

class NullSink final : public tlvdemux::MseSink {
public:
    void onMseInit(tlvdemux::MseTrackInit&&) override {}
    void onMseSegment(tlvdemux::MseMediaSegment&&) override {}
};

} // namespace

int main() {
    NullSink sink;
    tlvdemux::PlaybackStateMachine playback;
    tlvdemux::MseRemuxer remuxer(sink);
    aribtlv::AccessUnit unit;
    remuxer.push(unit);
    (void)playback;
    remuxer.flush();
    return 0;
}
