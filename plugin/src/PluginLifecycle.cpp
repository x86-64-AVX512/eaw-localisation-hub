#include "PluginLifecycle.h"

namespace eaw::plugin {

bool Lifecycle::Connect() noexcept {
    return transport_.exchange(TransportState::connected) == TransportState::disconnected;
}

void Lifecycle::Disconnect() noexcept {
    transport_.store(TransportState::disconnected);
}

bool Lifecycle::Connected() const noexcept {
    return transport_.load() == TransportState::connected;
}

void Lifecycle::AgentHello() noexcept {
    workspace_ = WorkspaceState::available;
}

void Lifecycle::SetDocumentStatus(const std::string& status) noexcept {
    if (status == "online") document_ = DocumentState::online;
    else if (status == "offline") document_ = DocumentState::offline;
    else if (status == "unauthorized") document_ = DocumentState::unauthorized;
    else if (status == "git-branch-outdated") document_ = DocumentState::branchOutdated;
    else if (status == "git-file-outdated") document_ = DocumentState::fileOutdated;
    else if (status == "git-conflict") document_ = DocumentState::gitConflict;
    else if (status == "file-unavailable") document_ = DocumentState::fileUnavailable;
    else if (status == "error") document_ = DocumentState::failed;
    else document_ = DocumentState::syncing;
    if (status == "branch-changed") workspace_ = WorkspaceState::branchChanged;
}

void Lifecycle::DocumentReady() noexcept {
    document_ = DocumentState::online;
}

void Lifecycle::DocumentClosed() noexcept {
    document_ = DocumentState::connecting;
}

void Lifecycle::WorkspaceChanged() noexcept {
    workspace_ = WorkspaceState::branchChanged;
    document_ = DocumentState::connecting;
}

void Lifecycle::WorkspaceAvailable() noexcept {
    workspace_ = WorkspaceState::available;
}

bool Lifecycle::Ready() const noexcept {
    return document_ == DocumentState::online && workspace_ == WorkspaceState::available;
}

bool Lifecycle::BranchBlocked() const noexcept {
    return workspace_ == WorkspaceState::branchChanged;
}

bool Lifecycle::Online() const noexcept {
    return document_ == DocumentState::online;
}

std::string Lifecycle::Status() const {
    if (workspace_ == WorkspaceState::branchChanged) return "branch-changed";
    switch (document_) {
        case DocumentState::online: return "online";
        case DocumentState::offline: return "offline";
        case DocumentState::unauthorized: return "unauthorized";
        case DocumentState::branchOutdated: return "git-branch-outdated";
        case DocumentState::fileOutdated: return "git-file-outdated";
        case DocumentState::gitConflict: return "git-conflict";
        case DocumentState::fileUnavailable: return "file-unavailable";
        case DocumentState::failed: return "error";
        case DocumentState::syncing: return "syncing";
        case DocumentState::connecting: return "connecting";
    }
    return "connecting";
}

std::wstring Lifecycle::PanelStatus(bool tracked) const {
    if (BranchBlocked()) return L"Git-ветка переключается. Открытые документы будут переподключены автоматически.";
    if (!Connected()) return L"Agent отключён. Ожидание подключения…";
    if (!tracked) return L"Agent подключён. Этот файл не участвует в совместной работе.";
    const std::string state = Status();
    if (state == "offline") return L"Agent подключён, но сервер недоступен. Изменения ожидают переподключения.";
    if (state == "unauthorized") return L"Сервер отклонил авторизацию. Выполните вход в Desktop Agent и перезапустите его.";
    if (state == "git-branch-outdated") return L"В Git появилась новая версия ветки. Этот файл не менялся и остаётся доступен для работы.";
    if (state == "git-file-outdated") return L"Этот файл изменён в новой Git-версии. Обновите репозиторий через GitHub Desktop; редактирование заблокировано.";
    if (state == "git-conflict") return L"Новая Git-версия конфликтует с совместными изменениями. Откройте Review для просмотра diff.";
    if (state == "file-unavailable") return L"Открытый файл отсутствует в текущей Git-ветке.";
    if (state == "error") return L"Синхронизация документа завершилась ошибкой.";
    if (!Ready()) return L"Синхронизация документа…";
    return L"Подключено. Совместные изменения синхронизируются.";
}

}  // namespace eaw::plugin
