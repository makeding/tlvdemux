#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tlvdemux {

enum class SessionState { Closed, Opening, Ready, WaitingForData, Ended, Failed };

enum class IndexState {
    Absent,
    Loading,
    Building,
    Partial,
    Following,
    Complete,
    Stale,
    Failed,
};

enum class SeekState {
    Idle,
    Resolving,
    AwaitingIndex,
    Repositioning,
    Priming,
    Prerolling,
    Landing,
    Failed,
};

enum class SeekPolicy {
    IndexedRandomAccess,
    AdaptiveRangeProbe,
    BufferedOnly,
    Unsupported,
};

struct SourceCapabilities {
    bool random_access = false;
    bool size_known = false;
    bool growing = false;
    bool stable_identity = false;
    bool remote_index_available = false;
    std::size_t preferred_read_size = 1024 * 1024;
};

struct SourceIdentity {
    std::string value;
    std::uint64_t generation = 0;
    std::optional<std::uint64_t> size;
};

struct ReadRequest {
    std::uint64_t offset = 0;
    std::size_t size = 0;
    std::uint64_t session_id = 0;
    std::uint64_t seek_generation = 0;
};

enum class ReadStatus { Data, EndOfInput, RetryableError, FatalError };

struct ReadResult {
    ReadStatus status = ReadStatus::Data;
    std::uint64_t offset = 0;
    std::vector<std::uint8_t> data;
    std::uint64_t session_id = 0;
    std::uint64_t seek_generation = 0;
    std::string message;
};

class RandomAccessSource {
public:
    virtual ~RandomAccessSource() = default;
    virtual SourceCapabilities capabilities() const = 0;
    virtual SourceIdentity identity() const = 0;
    virtual ReadResult read(const ReadRequest&) = 0;
};

SeekPolicy chooseSeekPolicy(const SourceCapabilities&, bool usable_index,
                            bool buffered_seek_available) noexcept;

class PlaybackStateMachine {
public:
    bool beginOpen(SourceCapabilities, SeekPolicy);
    bool completeOpen();
    bool close();
    bool failSession();
    bool reachGrowingEnd();
    bool reachFinalEnd();
    bool sourceGrew();
    bool sourceFinalized(bool unread_data);

    bool startIndexLoading();
    bool startIndexBuilding();
    bool loadedIndex(bool complete);
    bool markIndexStale();
    bool failIndex();
    bool pauseIndex();
    bool reachIndexEnd(bool growing);

    std::optional<std::uint64_t> requestSeek();
    bool awaitIndex(std::uint64_t generation);
    bool resumeResolving(std::uint64_t generation);
    bool beginReposition(std::uint64_t generation);
    bool beginPriming(std::uint64_t generation);
    bool beginPreroll(std::uint64_t generation);
    bool beginLanding(std::uint64_t generation);
    bool completeSeek(std::uint64_t generation);
    bool failSeek(std::uint64_t generation);
    bool finishFailedSeek(std::uint64_t generation);
    bool cancelSeek();

    bool accepts(std::uint64_t session_id, std::uint64_t seek_generation) const noexcept;

    SessionState sessionState() const noexcept { return session_state_; }
    IndexState indexState() const noexcept { return index_state_; }
    SeekState seekState() const noexcept { return seek_state_; }
    SeekPolicy seekPolicy() const noexcept { return seek_policy_; }
    const SourceCapabilities& sourceCapabilities() const noexcept { return capabilities_; }
    std::uint64_t sessionId() const noexcept { return session_id_; }
    std::uint64_t seekGeneration() const noexcept { return seek_generation_; }

private:
    bool current_seek(std::uint64_t generation) const noexcept;
    bool active_session() const noexcept;

    SessionState session_state_ = SessionState::Closed;
    IndexState index_state_ = IndexState::Absent;
    SeekState seek_state_ = SeekState::Idle;
    SeekPolicy seek_policy_ = SeekPolicy::Unsupported;
    SourceCapabilities capabilities_;
    std::uint64_t session_id_ = 0;
    std::uint64_t seek_generation_ = 0;
};

} // namespace tlvdemux

