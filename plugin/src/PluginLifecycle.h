#pragma once

#include <atomic>
#include <string>

namespace eaw::plugin {

enum class TransportState { disconnected, connected };
enum class DocumentState {
    connecting, syncing, online, offline, unauthorized,
    branchOutdated, fileOutdated, gitConflict, fileUnavailable, failed,
};
enum class WorkspaceState { available, branchChanged };

class Lifecycle final {
public:
    bool Connect() noexcept;
    void Disconnect() noexcept;
    bool Connected() const noexcept;

    void AgentHello() noexcept;
    void SetDocumentStatus(const std::string& status) noexcept;
    void DocumentReady() noexcept;
    void DocumentClosed() noexcept;
    void WorkspaceChanged() noexcept;
    void WorkspaceAvailable() noexcept;

    bool Ready() const noexcept;
    bool BranchBlocked() const noexcept;
    bool Online() const noexcept;
    std::string Status() const;
    std::wstring PanelStatus(bool tracked) const;

private:
    std::atomic<TransportState> transport_{TransportState::disconnected};
    DocumentState document_{DocumentState::connecting};
    WorkspaceState workspace_{WorkspaceState::available};
};

}  // namespace eaw::plugin
