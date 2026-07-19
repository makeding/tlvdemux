#include <tlvdemux/demuxer.hpp>

namespace {

class NullSink final : public tlvdemux::Sink {
public:
    void onService(const tlvdemux::ServiceInfo&) override {}
    void onTrack(const tlvdemux::TrackInfo&) override {}
    void onAccessUnit(tlvdemux::AccessUnit&&) override {}
    void onError(const tlvdemux::Error&) override {}
};

} // namespace

int main() {
    NullSink sink;
    tlvdemux::Demuxer demuxer(sink);
    demuxer.flush();
    return 0;
}

