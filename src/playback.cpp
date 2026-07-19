#include <tlvdemux/playback.hpp>

namespace tlvdemux {

SeekPolicy chooseSeekPolicy(const SourceCapabilities& capabilities,
                            const bool usable_index,
                            const bool buffered_seek_available) noexcept {
    if (capabilities.random_access && usable_index) {
        return SeekPolicy::IndexedRandomAccess;
    }
    if (capabilities.random_access && capabilities.size_known) {
        return SeekPolicy::AdaptiveRangeProbe;
    }
    if (buffered_seek_available) {
        return SeekPolicy::BufferedOnly;
    }
    return SeekPolicy::Unsupported;
}

bool PlaybackStateMachine::active_session() const noexcept {
    return session_state_ != SessionState::Closed && session_state_ != SessionState::Failed;
}

bool PlaybackStateMachine::current_seek(const std::uint64_t generation) const noexcept {
    return active_session() && generation == seek_generation_;
}

bool PlaybackStateMachine::beginOpen(SourceCapabilities capabilities,
                                     const SeekPolicy policy) {
    if (session_state_ != SessionState::Closed) return false;
    ++session_id_;
    ++seek_generation_;
    capabilities_ = capabilities;
    seek_policy_ = policy;
    session_state_ = SessionState::Opening;
    index_state_ = IndexState::Absent;
    seek_state_ = SeekState::Idle;
    return true;
}

bool PlaybackStateMachine::completeOpen() {
    if (session_state_ != SessionState::Opening) return false;
    session_state_ = SessionState::Ready;
    return true;
}

bool PlaybackStateMachine::close() {
    if (session_state_ == SessionState::Closed) return false;
    ++seek_generation_;
    session_state_ = SessionState::Closed;
    index_state_ = IndexState::Absent;
    seek_state_ = SeekState::Idle;
    seek_policy_ = SeekPolicy::Unsupported;
    capabilities_ = {};
    return true;
}

bool PlaybackStateMachine::failSession() {
    if (!active_session() || session_state_ == SessionState::Failed) return false;
    ++seek_generation_;
    session_state_ = SessionState::Failed;
    seek_state_ = SeekState::Idle;
    return true;
}

bool PlaybackStateMachine::reachGrowingEnd() {
    if (session_state_ != SessionState::Ready || !capabilities_.growing) return false;
    session_state_ = SessionState::WaitingForData;
    return true;
}

bool PlaybackStateMachine::reachFinalEnd() {
    if (session_state_ != SessionState::Ready || capabilities_.growing) return false;
    session_state_ = SessionState::Ended;
    return true;
}

bool PlaybackStateMachine::sourceGrew() {
    if (!capabilities_.growing ||
        (session_state_ != SessionState::Ready &&
         session_state_ != SessionState::WaitingForData)) {
        return false;
    }
    if (session_state_ == SessionState::WaitingForData) session_state_ = SessionState::Ready;
    if (index_state_ == IndexState::Following) index_state_ = IndexState::Building;
    return true;
}

bool PlaybackStateMachine::sourceFinalized(const bool unread_data) {
    if (!active_session() || !capabilities_.growing) return false;
    capabilities_.growing = false;
    if (index_state_ == IndexState::Following) {
        index_state_ = unread_data ? IndexState::Building : IndexState::Complete;
    }
    if (session_state_ == SessionState::WaitingForData) {
        session_state_ = unread_data ? SessionState::Ready : SessionState::Ended;
    }
    return true;
}

bool PlaybackStateMachine::startIndexLoading() {
    if (!active_session() || index_state_ != IndexState::Absent) return false;
    index_state_ = IndexState::Loading;
    return true;
}

bool PlaybackStateMachine::startIndexBuilding() {
    if (!active_session()) return false;
    switch (index_state_) {
    case IndexState::Absent:
    case IndexState::Partial:
    case IndexState::Following:
    case IndexState::Stale:
    case IndexState::Failed:
        index_state_ = IndexState::Building;
        return true;
    default:
        return false;
    }
}

bool PlaybackStateMachine::loadedIndex(const bool complete) {
    if (index_state_ != IndexState::Loading) return false;
    index_state_ = complete ? IndexState::Complete : IndexState::Partial;
    return true;
}

bool PlaybackStateMachine::markIndexStale() {
    if (index_state_ != IndexState::Loading && index_state_ != IndexState::Complete &&
        index_state_ != IndexState::Partial) {
        return false;
    }
    index_state_ = IndexState::Stale;
    return true;
}

bool PlaybackStateMachine::failIndex() {
    if (!active_session() || index_state_ == IndexState::Absent ||
        index_state_ == IndexState::Failed) {
        return false;
    }
    index_state_ = IndexState::Failed;
    return true;
}

bool PlaybackStateMachine::pauseIndex() {
    if (index_state_ != IndexState::Building) return false;
    index_state_ = IndexState::Partial;
    return true;
}

bool PlaybackStateMachine::reachIndexEnd(const bool growing) {
    if (index_state_ != IndexState::Building) return false;
    index_state_ = growing ? IndexState::Following : IndexState::Complete;
    return true;
}

std::optional<std::uint64_t> PlaybackStateMachine::requestSeek() {
    if (session_state_ != SessionState::Ready &&
        session_state_ != SessionState::WaitingForData &&
        session_state_ != SessionState::Ended) {
        return std::nullopt;
    }
    if (session_state_ == SessionState::Ended ||
        session_state_ == SessionState::WaitingForData) {
        session_state_ = SessionState::Ready;
    }
    ++seek_generation_;
    seek_state_ = SeekState::Resolving;
    return seek_generation_;
}

bool PlaybackStateMachine::awaitIndex(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Resolving) return false;
    seek_state_ = SeekState::AwaitingIndex;
    return true;
}

bool PlaybackStateMachine::resumeResolving(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::AwaitingIndex) return false;
    seek_state_ = SeekState::Resolving;
    return true;
}

bool PlaybackStateMachine::beginReposition(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Resolving) return false;
    seek_state_ = SeekState::Repositioning;
    return true;
}

bool PlaybackStateMachine::beginPriming(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Repositioning) return false;
    seek_state_ = SeekState::Priming;
    return true;
}

bool PlaybackStateMachine::beginPreroll(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Priming) return false;
    seek_state_ = SeekState::Prerolling;
    return true;
}

bool PlaybackStateMachine::beginLanding(const std::uint64_t generation) {
    if (!current_seek(generation) ||
        (seek_state_ != SeekState::Priming && seek_state_ != SeekState::Prerolling)) {
        return false;
    }
    seek_state_ = SeekState::Landing;
    return true;
}

bool PlaybackStateMachine::completeSeek(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Landing) return false;
    seek_state_ = SeekState::Idle;
    return true;
}

bool PlaybackStateMachine::failSeek(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ == SeekState::Idle ||
        seek_state_ == SeekState::Failed) {
        return false;
    }
    seek_state_ = SeekState::Failed;
    return true;
}

bool PlaybackStateMachine::finishFailedSeek(const std::uint64_t generation) {
    if (!current_seek(generation) || seek_state_ != SeekState::Failed) return false;
    seek_state_ = SeekState::Idle;
    return true;
}

bool PlaybackStateMachine::cancelSeek() {
    if (seek_state_ == SeekState::Idle) return false;
    ++seek_generation_;
    seek_state_ = SeekState::Idle;
    return true;
}

bool PlaybackStateMachine::accepts(const std::uint64_t session_id,
                                   const std::uint64_t seek_generation) const noexcept {
    return active_session() && session_id == session_id_ && seek_generation == seek_generation_;
}

} // namespace tlvdemux
