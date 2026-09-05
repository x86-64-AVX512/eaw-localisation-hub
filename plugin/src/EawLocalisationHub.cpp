#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <deque>
#include <memory>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include "PluginInterface.h"
#include "DockingFeature/Docking.h"
#include "CollaborationOverlays.h"
#include "EditorInterop.h"
#include "IpcSecurity.h"
#include "LegacyIntegrationSettings.h"
#include "PluginLifecycle.h"
#include "PluginModel.h"
#include "ProtocolMessage.h"
#include "VisualStyle.h"
namespace {

constexpr wchar_t kPluginName[] = L"EaW Localisation Hub 0.8.7F1";
constexpr std::int64_t kProtocolVersion = EAW_HUB_PROTOCOL_VERSION;
constexpr size_t kMaximumIpcMessageBytes = 12 * 1024 * 1024;
constexpr ULONGLONG kPresenceHeartbeatMilliseconds = 10 * 1000;
constexpr UINT kIncomingMessage = WM_APP + 0x451, kConnectedMessage = WM_APP + 0x452;
constexpr UINT kDisconnectedMessage = WM_APP + 0x453;
constexpr UINT_PTR kObserverTimerId = 0x45415703, kMainSubclassId = 0x45415701;
constexpr UINT_PTR kScintillaSubclassId = 0x45415702;
constexpr int kReservationIndicator = 20, kPresenceIndicator = 21;
constexpr int kCommentIndicator = 22, kSuggestionIndicator = 23;
constexpr int kIndicatorFlagValueFore = 1;
constexpr int kPanelDialogId = 101, kTextInputDialogId = 102;
constexpr int kStatusControl = 1101, kIdentityControl = 1102, kFileControl = 1103;
constexpr int kParticipantsLabel = 1104, kParticipantsList = 1105;
constexpr int kReservationsLabel = 1106, kReservationsList = 1107;
constexpr int kReserveButton = 1108, kDeleteButton = 1109;
constexpr int kConflictsLabel = 1110, kConflictsList = 1111;
constexpr int kKeepCollaborativeButton = 1112, kUseExternalButton = 1113;
constexpr int kReservationTargetLabel = 1114, kReservationTargetCombo = 1115;
constexpr int kCommentsLabel = 1116, kCommentsList = 1117;
constexpr int kCommentReplyButton = 1118, kCommentStatusButton = 1119, kCommentDeleteButton = 1120;
constexpr int kSuggestionsLabel = 1121, kSuggestionsList = 1122;
constexpr int kSuggestionReplyButton = 1123, kSuggestionAcceptButton = 1124;
constexpr int kSuggestionRejectButton = 1125, kSuggestionDeleteButton = 1126;
constexpr int kSuggestionDisplayLabel = 1127, kSuggestionDisplayCombo = 1128;
constexpr int kInputLabel = 1201, kInputEdit = 1202;

using eaw::plugin::CommentEntry; using eaw::plugin::DiscussionEntry;
using eaw::plugin::ExternalConflictEntry; using eaw::plugin::PresenceEntry;
using eaw::plugin::PresenceOverlayHit; using eaw::plugin::ReservationEntry;
using eaw::plugin::ReservationTargetEntry; using eaw::plugin::SuggestionEntry;
using eaw::plugin::SuggestionDisplayMode; using eaw::plugin::SuggestionOverlayHit;
using eaw::plugin::TextInputContext;
using eaw::editor::Base64Decode; using eaw::editor::Base64Encode;
using eaw::editor::IsTrackedPath; using eaw::editor::NormalisePath;
using eaw::editor::Utf8ToWide; using eaw::editor::WideToUtf8;
using eaw::ipc::ConstantTimeHexEqual; using eaw::ipc::DerivedPipeName;
using eaw::ipc::HmacSha256; using eaw::ipc::ReadIpcSecret;
using eaw::visual::ColorFromString; using eaw::visual::ReadableAnnotationColor;
using eaw::visual::RectanglesOverlap;

HINSTANCE g_instance = nullptr;
NppData g_nppData{};
FuncItem g_functions[10]{};
ShortcutKey g_reserveShortcut{true, true, false, 'R'};
ShortcutKey g_undoShortcut{true, true, false, 'Z'};
ShortcutKey g_redoShortcut{true, true, false, 'Y'};
HANDLE g_pipe = INVALID_HANDLE_VALUE, g_pipeThread = nullptr, g_writerThread = nullptr;
HANDLE g_stopEvent = nullptr, g_writeEvent = nullptr;
CRITICAL_SECTION g_pipeLock{}, g_outboundLock{};
std::atomic_bool g_lockInitialised{false}, g_outboundLockInitialised{false};
std::atomic_bool g_applyingRemote{false}, g_started{false}, g_ipcAuthenticated{false};
bool g_integrationEnabled = false, g_notepadReady = false;
std::string g_clientId, g_ipcSecret, g_agentUser, g_agentUserId;
std::string g_agentColor{"#6aa9ff"};
std::string g_workspace, g_currentDocumentPath, g_activePresencePath, g_pendingReviewPath;
std::string g_lastNotice, g_documentStatusMessage, g_observedPath, g_observedText;
eaw::plugin::Lifecycle g_lifecycle;
ULONGLONG g_saveDueAt = 0;
std::string g_savePath;
HWND g_panel = nullptr, g_statusControl = nullptr, g_identityControl = nullptr, g_fileControl = nullptr;
HWND g_participantsList = nullptr, g_reservationsList = nullptr, g_reserveButton = nullptr;
HWND g_deleteButton = nullptr, g_reservationTargetCombo = nullptr, g_conflictsList = nullptr;
HWND g_keepCollaborativeButton = nullptr, g_useExternalButton = nullptr, g_commentsList = nullptr;
HWND g_commentReplyButton = nullptr, g_commentStatusButton = nullptr, g_commentDeleteButton = nullptr;
HWND g_suggestionsList = nullptr, g_suggestionReplyButton = nullptr, g_suggestionAcceptButton = nullptr;
HWND g_suggestionRejectButton = nullptr, g_suggestionDeleteButton = nullptr, g_suggestionDisplayCombo = nullptr;
DockedWidgetData g_panelDockData{};
std::vector<PresenceEntry> g_presences;
std::vector<PresenceOverlayHit> g_presenceOverlayHits;
std::vector<std::string> g_hoveredPresenceIds;
std::vector<ReservationEntry> g_reservations;
std::vector<ReservationTargetEntry> g_reservationTargets;
std::vector<std::string> g_hoveredReservationIds;
POINT g_reservationHoverPoint{};
RECT g_reservationHoverLabel{};
bool g_reservationHoverLabelVisible = false;
std::vector<ExternalConflictEntry> g_externalConflicts;
std::vector<CommentEntry> g_comments;
std::vector<SuggestionEntry> g_suggestions;
SuggestionDisplayMode g_suggestionDisplayMode = SuggestionDisplayMode::Review;
std::vector<SuggestionOverlayHit> g_suggestionOverlayHits;
std::vector<std::string> g_hoveredSuggestionIds;
std::map<std::string, std::vector<DiscussionEntry>> g_commentMessages;
std::map<std::string, std::vector<DiscussionEntry>> g_suggestionMessages;
std::deque<std::string> g_outbound;
std::string g_lastCursorPath;
LRESULT g_lastCursorPosition = -1;
LRESULT g_lastCursorAnchor = -1;
ULONGLONG g_lastPresenceSentAt = 0;

void ReserveSelection();
void DeleteReservationAtCaret();
void CollaborativeUndo();
void CollaborativeRedo();
void ShowCollaborationPanel();
void ShowConnectionStatus();
void CreateComment();
void CreateSuggestion();
void OpenReviewApplication();
void ToggleIntegration();
void SendCurrentDocument();
void SendCursor(bool force = false);
void CloseDocument(UINT_PTR bufferId);
void PollCurrentDocument();
std::string CurrentDocumentText();
void WritePipeLine(const std::string& message, bool priority = false);
void UpdatePanel();
void SyncReviewPanelToViewport();
void RefreshPresenceVisuals();
void RefreshSuggestionVisuals();
void EnsurePanel(bool show);
void ScheduleAutoSave(bool immediate = false);
void MaybeAutoSave();
INT_PTR CALLBACK PanelDialogProcedure(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam);
INT_PTR CALLBACK TextInputDialogProcedure(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam);

void UpdateIntegrationMenuCheck() {
    if (!g_nppData._nppHandle || !g_functions[0]._cmdID) return;
    SendMessageW(
        g_nppData._nppHandle,
        NPPM_SETMENUITEMCHECK,
        static_cast<WPARAM>(g_functions[0]._cmdID),
        static_cast<LPARAM>(g_integrationEnabled));
}

HWND CurrentScintilla() {
    return eaw::editor::CurrentScintilla(g_nppData);
}
std::wstring CurrentPathWide() {
    return eaw::editor::CurrentPath(g_nppData);
}
std::wstring PathFromBufferId(UINT_PTR bufferId) {
    return eaw::editor::PathFromBufferId(g_nppData, bufferId);
}
std::string JsonEscape(const std::string& value) {
    return eaw::protocol::EscapeString(value);
}
bool MessageMatchesCurrentPath(const eaw::protocol::Message& message) {
    const std::string messagePath = message.String("path");
    if (messagePath.empty()) return false;
    return NormalisePath(messagePath) == NormalisePath(WideToUtf8(CurrentPathWide()));
}
void InvalidatePresenceOverlays() {
    eaw::overlays::Invalidate(g_nppData);
}
void ClearPresenceHover() {
    eaw::overlays::ClearPresenceHover(g_nppData, g_hoveredPresenceIds);
}
void UpdatePresenceHover(HWND scintilla, POINT point) {
    eaw::overlays::UpdatePresenceHover(
        scintilla, CurrentScintilla(), point, g_presenceOverlayHits, g_hoveredPresenceIds);
}
void DrawPresenceOverlays(HWND scintilla) {
    eaw::overlays::DrawPresences(
        scintilla, CurrentScintilla(), g_presences, g_presenceOverlayHits, g_hoveredPresenceIds);
}
void ClearSuggestionHover() {
    eaw::overlays::ClearSuggestionHover(g_nppData, g_hoveredSuggestionIds);
}
void UpdateSuggestionHover(HWND scintilla, POINT point) {
    eaw::overlays::UpdateSuggestionHover(
        scintilla, CurrentScintilla(), point, g_suggestionOverlayHits, g_hoveredSuggestionIds);
}
void ClearReservationHover() {
    eaw::overlays::ClearReservationHover(
        g_nppData, g_hoveredReservationIds, g_reservationHoverLabelVisible);
}

void UpdateReservationHover(HWND scintilla, POINT point) {
    eaw::overlays::UpdateReservationHover(
        scintilla,
        CurrentScintilla(),
        point,
        g_reservations,
        g_hoveredReservationIds,
        g_reservationHoverPoint,
        g_reservationHoverLabel,
        g_reservationHoverLabelVisible);
}

void DrawReservationHover(HWND scintilla) {
    eaw::overlays::DrawReservationHover(
        scintilla,
        CurrentScintilla(),
        g_reservations,
        g_hoveredReservationIds,
        g_reservationHoverPoint,
        g_reservationHoverLabel,
        g_reservationHoverLabelVisible);
}
std::wstring CurrentFileName() {
    const std::wstring path = CurrentPathWide();
    const size_t separator = path.find_last_of(L"\\/");
    return separator == std::wstring::npos ? path : path.substr(separator + 1);
}

HWND CreatePanelControl(
    HWND parent,
    const wchar_t* className,
    const wchar_t* text,
    DWORD style,
    DWORD extendedStyle,
    int id) {
    HWND control = CreateWindowExW(
        extendedStyle,
        className,
        text,
        WS_CHILD | WS_VISIBLE | style,
        0, 0, 10, 10,
        parent,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
        g_instance,
        nullptr);
    if (control) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
    return control;
}

void LayoutPanel(HWND dialog) {
    RECT client{};
    GetClientRect(dialog, &client);
    const int width = std::max(280L, client.right - client.left);
    const int height = std::max(620L, client.bottom - client.top);
    const int margin = 10;
    const int contentWidth = std::max(240, width - margin * 2);
    const int halfButton = std::max(100, (contentWidth - 6) / 2);

    MoveWindow(g_statusControl, margin, 8, contentWidth, 42, TRUE);
    MoveWindow(g_identityControl, margin, 52, contentWidth, 20, TRUE);
    MoveWindow(g_fileControl, margin, 73, contentWidth, 20, TRUE);
    MoveWindow(GetDlgItem(dialog, kParticipantsLabel), margin, 98, contentWidth, 18, TRUE);
    MoveWindow(g_participantsList, margin, 117, contentWidth, 42, TRUE);
    MoveWindow(GetDlgItem(dialog, kReservationsLabel), margin, 164, contentWidth, 18, TRUE);
    MoveWindow(g_reservationsList, margin, 183, contentWidth, 44, TRUE);
    MoveWindow(GetDlgItem(dialog, kReservationTargetLabel), margin, 234, 72, 22, TRUE);
    MoveWindow(g_reservationTargetCombo, margin + 74, 230, std::max(160, contentWidth - 74), 240, TRUE);
    MoveWindow(g_reserveButton, margin, 260, halfButton, 28, TRUE);
    MoveWindow(g_deleteButton, margin + halfButton + 6, 260,
        std::max(100, contentWidth - halfButton - 6), 28, TRUE);

    const bool showConflicts = !g_externalConflicts.empty();
    const int conflictBlockHeight = showConflicts ? 130 : 0;
    const int reviewBottom = height - margin - conflictBlockHeight;
    const int commentsLabelY = 296;
    const int commentsY = commentsLabelY + 20;
    const int fixedReviewChrome = 27 + 26 + 20 + 27 + 10;
    const int availableForLists = std::max(110, reviewBottom - commentsY - fixedReviewChrome);
    const int commentsHeight = availableForLists / 2;
    const int suggestionsHeight = availableForLists - commentsHeight;

    MoveWindow(GetDlgItem(dialog, kCommentsLabel), margin, commentsLabelY, contentWidth, 18, TRUE);
    MoveWindow(g_commentsList, margin, commentsY, contentWidth, commentsHeight, TRUE);
    const int commentButtonsY = commentsY + commentsHeight + 4;
    const int commentButtonWidth = std::max(75, (contentWidth - 12) / 3);
    MoveWindow(g_commentReplyButton, margin, commentButtonsY, commentButtonWidth, 27, TRUE);
    MoveWindow(g_commentStatusButton, margin + commentButtonWidth + 6, commentButtonsY, commentButtonWidth, 27, TRUE);
    MoveWindow(g_commentDeleteButton, margin + (commentButtonWidth + 6) * 2, commentButtonsY,
        std::max(75, contentWidth - (commentButtonWidth + 6) * 2), 27, TRUE);

    const int suggestionsLabelY = commentButtonsY + 32;
    const int displayComboWidth = std::clamp(contentWidth / 2, 135, 190);
    MoveWindow(GetDlgItem(dialog, kSuggestionsLabel), margin, suggestionsLabelY,
        std::max(80, contentWidth - displayComboWidth - 48), 18, TRUE);
    MoveWindow(GetDlgItem(dialog, kSuggestionDisplayLabel),
        margin + contentWidth - displayComboWidth - 42, suggestionsLabelY,
        38, 18, TRUE);
    MoveWindow(g_suggestionDisplayCombo,
        margin + contentWidth - displayComboWidth, suggestionsLabelY - 3,
        displayComboWidth, 180, TRUE);
    const int suggestionsY = suggestionsLabelY + 20;
    MoveWindow(g_suggestionsList, margin, suggestionsY, contentWidth, suggestionsHeight, TRUE);
    const int suggestionButtonsY = suggestionsY + suggestionsHeight + 4;
    const int suggestionButtonWidth = std::max(60, (contentWidth - 18) / 4);
    MoveWindow(g_suggestionReplyButton, margin, suggestionButtonsY, suggestionButtonWidth, 27, TRUE);
    MoveWindow(g_suggestionAcceptButton, margin + suggestionButtonWidth + 6, suggestionButtonsY, suggestionButtonWidth, 27, TRUE);
    MoveWindow(g_suggestionRejectButton, margin + (suggestionButtonWidth + 6) * 2, suggestionButtonsY, suggestionButtonWidth, 27, TRUE);
    MoveWindow(g_suggestionDeleteButton, margin + (suggestionButtonWidth + 6) * 3, suggestionButtonsY,
        std::max(60, contentWidth - (suggestionButtonWidth + 6) * 3), 27, TRUE);

    const int conflictsLabelY = height - conflictBlockHeight;
    const int conflictsY = conflictsLabelY + 20;
    const int resolutionButtonY = height - margin - 30;
    ShowWindow(GetDlgItem(dialog, kConflictsLabel), showConflicts ? SW_SHOW : SW_HIDE);
    ShowWindow(g_conflictsList, showConflicts ? SW_SHOW : SW_HIDE);
    ShowWindow(g_keepCollaborativeButton, showConflicts ? SW_SHOW : SW_HIDE);
    ShowWindow(g_useExternalButton, showConflicts ? SW_SHOW : SW_HIDE);
    if (showConflicts) {
        MoveWindow(GetDlgItem(dialog, kConflictsLabel), margin, conflictsLabelY, contentWidth, 18, TRUE);
        MoveWindow(g_conflictsList, margin, conflictsY, contentWidth,
            std::max(40, resolutionButtonY - conflictsY - 6), TRUE);
        MoveWindow(g_keepCollaborativeButton, margin, resolutionButtonY, halfButton, 30, TRUE);
        MoveWindow(g_useExternalButton, margin + halfButton + 6, resolutionButtonY,
            std::max(100, contentWidth - halfButton - 6), 30, TRUE);
    }
}

void RefreshReservationTargets() {
    if (!g_reservationTargetCombo) return;
    std::string selectedId;
    std::string selectedName;
    const LRESULT selected = SendMessageW(g_reservationTargetCombo, CB_GETCURSEL, 0, 0);
    if (selected != CB_ERR && static_cast<size_t>(selected) < g_reservationTargets.size()) {
        selectedId = g_reservationTargets[static_cast<size_t>(selected)].id;
        selectedName = g_reservationTargets[static_cast<size_t>(selected)].displayName;
    }
    SendMessageW(g_reservationTargetCombo, CB_RESETCONTENT, 0, 0);
    LRESULT selection = CB_ERR;
    for (size_t index = 0; index < g_reservationTargets.size(); ++index) {
        const ReservationTargetEntry& target = g_reservationTargets[index];
        std::wstring label = Utf8ToWide(target.displayName);
        if ((!target.id.empty() && target.id == g_agentUserId)
            || (target.id.empty() && target.displayName == g_agentUser)) {
            label += L" (вы)";
            if (selection == CB_ERR) selection = static_cast<LRESULT>(index);
        }
        SendMessageW(g_reservationTargetCombo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
        if ((!selectedId.empty() && target.id == selectedId)
            || (selectedId.empty() && !selectedName.empty() && target.displayName == selectedName)) {
            selection = static_cast<LRESULT>(index);
        }
    }
    if (selection == CB_ERR && !g_reservationTargets.empty()) selection = 0;
    if (selection != CB_ERR) SendMessageW(g_reservationTargetCombo, CB_SETCURSEL, selection, 0);
}

void AddPanelListItem(HWND list, const std::wstring& text, COLORREF color) {
    const LRESULT index = SendMessageW(list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(text.c_str()));
    if (index != LB_ERR && index != LB_ERRSPACE) {
        SendMessageW(list, LB_SETITEMDATA, static_cast<WPARAM>(index), static_cast<LPARAM>(color));
    }
}

void RefreshParticipantsList() {
    if (!g_participantsList) return;
    SendMessageW(g_participantsList, LB_RESETCONTENT, 0, 0);
    if (!g_agentUser.empty()) {
        AddPanelListItem(
            g_participantsList,
            Utf8ToWide(g_agentUser) + L" (вы)",
            ColorFromString(g_agentColor));
    }
    const HWND scintilla = CurrentScintilla();
    for (const PresenceEntry& presence : g_presences) {
        std::wstring label = Utf8ToWide(presence.user.empty() ? presence.clientId : presence.user);
        if (scintilla) {
            const LRESULT line = SendMessage(scintilla, SCI_LINEFROMPOSITION, presence.position, 0);
            label += L" – строка " + std::to_wstring(line + 1);
        }
        AddPanelListItem(g_participantsList, label, ColorFromString(presence.color, RGB(255, 145, 55)));
    }
}

std::wstring ReservationStatusLabel(const std::string& status) {
    if (status == "orphaned") return L"границы потеряны";
    if (status == "empty") return L"пустая";
    return L"активна";
}

void RefreshReservationsList() {
    if (!g_reservationsList) return;
    std::string selectedId;
    const LRESULT selected = SendMessageW(g_reservationsList, LB_GETCURSEL, 0, 0);
    if (selected != LB_ERR && static_cast<size_t>(selected) < g_reservations.size()) {
        selectedId = g_reservations[static_cast<size_t>(selected)].id;
    }

    SendMessageW(g_reservationsList, LB_RESETCONTENT, 0, 0);
    LRESULT restoredSelection = LB_ERR;
    for (size_t index = 0; index < g_reservations.size(); ++index) {
        const ReservationEntry& reservation = g_reservations[index];
        std::wstring label = Utf8ToWide(reservation.assignee.empty() ? "Неизвестно" : reservation.assignee);
        label += L" – " + std::to_wstring(reservation.keyCount) + L" ключей · ";
        label += ReservationStatusLabel(reservation.status);
        if (!reservation.comment.empty()) label += L" · " + Utf8ToWide(reservation.comment);
        if (!reservation.createdBy.empty() && reservation.createdBy != reservation.assignee) {
            label += L" · создал " + Utf8ToWide(reservation.createdBy);
        }
        AddPanelListItem(g_reservationsList, label, ColorFromString(reservation.color));
        if (reservation.id == selectedId) restoredSelection = static_cast<LRESULT>(index);
    }
    if (restoredSelection != LB_ERR) {
        SendMessageW(g_reservationsList, LB_SETCURSEL, static_cast<WPARAM>(restoredSelection), 0);
    }
}

std::wstring OneLine(std::wstring value, size_t maximum = 90) {
    std::replace(value.begin(), value.end(), L'\r', L' ');
    std::replace(value.begin(), value.end(), L'\n', L' ');
    std::replace(value.begin(), value.end(), L'\t', L' ');
    if (value.size() > maximum) value = value.substr(0, maximum - 1) + L"…";
    return value;
}

std::wstring ReviewStatusLabel(const std::string& status) {
    if (status == "resolved") return L"закрыт";
    if (status == "accepted") return L"принято";
    if (status == "rejected") return L"отклонено";
    if (status == "stale") return L"устарело";
    if (status == "orphaned") return L"границы потеряны";
    return L"открыто";
}

void RefreshCommentsList() {
    if (!g_commentsList) return;
    std::stable_sort(g_comments.begin(), g_comments.end(), [](const CommentEntry& left, const CommentEntry& right) {
        return left.start < right.start;
    });
    std::string selectedId;
    const LRESULT selected = SendMessageW(g_commentsList, LB_GETCURSEL, 0, 0);
    if (selected != LB_ERR && static_cast<size_t>(selected) < g_comments.size()) selectedId = g_comments[static_cast<size_t>(selected)].id;
    SendMessageW(g_commentsList, LB_RESETCONTENT, 0, 0);
    LRESULT restored = LB_ERR;
    for (size_t index = 0; index < g_comments.size(); ++index) {
        const CommentEntry& item = g_comments[index];
        std::wstring label = Utf8ToWide(item.author.empty() ? "Неизвестно" : item.author);
        if (const HWND scintilla = CurrentScintilla()) {
            label += L" · строка " + std::to_wstring(SendMessage(scintilla, SCI_LINEFROMPOSITION, item.start, 0) + 1);
        }
        label += L" · " + ReviewStatusLabel(item.status) + L" · " + std::to_wstring(item.messageCount) + L" сообщ.";
        label += L"\n" + OneLine(Utf8ToWide(item.summaryAuthor)) + L": " + OneLine(Utf8ToWide(item.summary));
        AddPanelListItem(g_commentsList, label, ColorFromString(item.color, RGB(235, 175, 35)));
        const size_t visibleMessages = std::min<size_t>(g_commentMessages[item.id].size(), 4);
        SendMessageW(g_commentsList, LB_SETITEMHEIGHT, index, std::clamp<LRESULT>(30 + visibleMessages * 19, 50, 112));
        if (item.id == selectedId) restored = static_cast<LRESULT>(index);
    }
    if (restored != LB_ERR) SendMessageW(g_commentsList, LB_SETCURSEL, restored, 0);
}

void RefreshSuggestionsList() {
    if (!g_suggestionsList) return;
    std::stable_sort(g_suggestions.begin(), g_suggestions.end(), [](const SuggestionEntry& left, const SuggestionEntry& right) {
        return left.start < right.start;
    });
    std::string selectedId;
    const LRESULT selected = SendMessageW(g_suggestionsList, LB_GETCURSEL, 0, 0);
    if (selected != LB_ERR && static_cast<size_t>(selected) < g_suggestions.size()) selectedId = g_suggestions[static_cast<size_t>(selected)].id;
    SendMessageW(g_suggestionsList, LB_RESETCONTENT, 0, 0);
    LRESULT restored = LB_ERR;
    for (size_t index = 0; index < g_suggestions.size(); ++index) {
        const SuggestionEntry& item = g_suggestions[index];
        std::wstring label = Utf8ToWide(item.author.empty() ? "Неизвестно" : item.author);
        if (const HWND scintilla = CurrentScintilla()) {
            label += L" · строка " + std::to_wstring(SendMessage(scintilla, SCI_LINEFROMPOSITION, item.start, 0) + 1);
        }
        label += L" · " + ReviewStatusLabel(item.status) + L" · ";
        label += OneLine(Utf8ToWide(item.original), 42) + L" → " + OneLine(Utf8ToWide(item.replacement), 42);
        AddPanelListItem(g_suggestionsList, label, ColorFromString(item.color, RGB(50, 175, 100)));
        const size_t visibleMessages = std::min<size_t>(g_suggestionMessages[item.id].size(), 3);
        SendMessageW(g_suggestionsList, LB_SETITEMHEIGHT, index, std::clamp<LRESULT>(51 + visibleMessages * 18, 51, 108));
        if (item.id == selectedId) restored = static_cast<LRESULT>(index);
    }
    if (restored != LB_ERR) SendMessageW(g_suggestionsList, LB_SETCURSEL, restored, 0);
}

void SyncReviewPanelToViewport() {
    if (!g_panel) return;
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    const LRESULT visibleLine = SendMessage(scintilla, SCI_GETFIRSTVISIBLELINE, 0, 0);
    const LRESULT firstDocumentLine = SendMessage(scintilla, SCI_DOCLINEFROMVISIBLE, visibleLine, 0);
    const auto syncList = [&](HWND list, const auto& entries) {
        if (!list || entries.empty()) return;
        size_t index = 0;
        while (index + 1 < entries.size()) {
            const LRESULT line = SendMessage(scintilla, SCI_LINEFROMPOSITION, entries[index].start, 0);
            if (line >= firstDocumentLine) break;
            ++index;
        }
        SendMessageW(list, LB_SETTOPINDEX, static_cast<WPARAM>(index), 0);
    };
    syncList(g_commentsList, g_comments);
    syncList(g_suggestionsList, g_suggestions);
}

void RefreshConflictsList() {
    if (!g_conflictsList) return;
    std::string selectedKey;
    const LRESULT selected = SendMessageW(g_conflictsList, LB_GETCURSEL, 0, 0);
    if (selected != LB_ERR && static_cast<size_t>(selected) < g_externalConflicts.size()) {
        selectedKey = g_externalConflicts[static_cast<size_t>(selected)].key;
    }
    SendMessageW(g_conflictsList, LB_RESETCONTENT, 0, 0);
    LRESULT restoredSelection = LB_ERR;
    for (size_t index = 0; index < g_externalConflicts.size(); ++index) {
        const ExternalConflictEntry& conflict = g_externalConflicts[index];
        std::wstring label = Utf8ToWide(conflict.label.empty() ? conflict.key : conflict.label);
        if (!conflict.detail.empty()) label += L" – " + Utf8ToWide(conflict.detail);
        SendMessageW(g_conflictsList, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
        if (conflict.key == selectedKey) restoredSelection = static_cast<LRESULT>(index);
    }
    if (restoredSelection != LB_ERR) {
        SendMessageW(g_conflictsList, LB_SETCURSEL, static_cast<WPARAM>(restoredSelection), 0);
    }
}

void UpdatePanel() {
    if (!g_panel) return;
    LayoutPanel(g_panel);
    const bool tracked = IsTrackedPath(CurrentPathWide());
    std::wstring status = g_lifecycle.PanelStatus(tracked);
    if (!g_externalConflicts.empty()) {
        status += L"\r\nКонфликтов Git: " + std::to_wstring(g_externalConflicts.size()) + L". Автосохранение приостановлено.";
    }
    if (!g_documentStatusMessage.empty()) status += L"\r\n" + Utf8ToWide(g_documentStatusMessage);
    if (!g_lastNotice.empty()) status += L"\r\n" + Utf8ToWide(g_lastNotice);
    SetWindowTextW(g_statusControl, status.c_str());

    std::wstring identity = L"Пользователь: ";
    identity += g_agentUser.empty() ? L"–" : Utf8ToWide(g_agentUser);
    identity += L" · Workspace: ";
    identity += g_workspace.empty() ? L"–" : Utf8ToWide(g_workspace);
    SetWindowTextW(g_identityControl, identity.c_str());

    std::wstring file = L"Файл: ";
    const std::wstring currentFileName = CurrentFileName();
    file += currentFileName.empty() ? L"–" : currentFileName;
    SetWindowTextW(g_fileControl, file.c_str());

    RefreshParticipantsList();
    RefreshReservationTargets();
    RefreshReservationsList();
    RefreshCommentsList();
    RefreshSuggestionsList();
    SyncReviewPanelToViewport();
    RefreshConflictsList();
    const bool actionsEnabled = g_lifecycle.Connected() && tracked && g_lifecycle.Ready();
    EnableWindow(g_reserveButton, actionsEnabled);
    EnableWindow(g_reservationTargetCombo, actionsEnabled && !g_reservationTargets.empty());
    EnableWindow(g_deleteButton, actionsEnabled && !g_reservations.empty());
    const LRESULT selectedComment = g_commentsList ? SendMessageW(g_commentsList, LB_GETCURSEL, 0, 0) : LB_ERR;
    const bool hasComment = selectedComment != LB_ERR && static_cast<size_t>(selectedComment) < g_comments.size();
    EnableWindow(g_commentReplyButton, actionsEnabled && hasComment);
    EnableWindow(g_commentStatusButton, actionsEnabled && hasComment);
    EnableWindow(g_commentDeleteButton, actionsEnabled && hasComment);
    if (hasComment) SetWindowTextW(g_commentStatusButton,
        g_comments[static_cast<size_t>(selectedComment)].status == "resolved" ? L"Вернуть" : L"Закрыть");
    const LRESULT selectedSuggestion = g_suggestionsList ? SendMessageW(g_suggestionsList, LB_GETCURSEL, 0, 0) : LB_ERR;
    const bool hasSuggestion = selectedSuggestion != LB_ERR && static_cast<size_t>(selectedSuggestion) < g_suggestions.size();
    const bool openSuggestion = hasSuggestion && g_suggestions[static_cast<size_t>(selectedSuggestion)].status == "open";
    EnableWindow(g_suggestionReplyButton, actionsEnabled && hasSuggestion);
    EnableWindow(g_suggestionAcceptButton, actionsEnabled && openSuggestion);
    EnableWindow(g_suggestionRejectButton, actionsEnabled && openSuggestion);
    EnableWindow(g_suggestionDeleteButton, actionsEnabled && hasSuggestion);
    EnableWindow(g_keepCollaborativeButton, actionsEnabled && !g_externalConflicts.empty());
    EnableWindow(g_useExternalButton, actionsEnabled && !g_externalConflicts.empty());
}

CommentEntry* SelectedComment() {
    if (!g_commentsList) return nullptr;
    const LRESULT selected = SendMessageW(g_commentsList, LB_GETCURSEL, 0, 0);
    return selected != LB_ERR && static_cast<size_t>(selected) < g_comments.size() ? &g_comments[static_cast<size_t>(selected)] : nullptr;
}

SuggestionEntry* SelectedSuggestion() {
    if (!g_suggestionsList) return nullptr;
    const LRESULT selected = SendMessageW(g_suggestionsList, LB_GETCURSEL, 0, 0);
    return selected != LB_ERR && static_cast<size_t>(selected) < g_suggestions.size() ? &g_suggestions[static_cast<size_t>(selected)] : nullptr;
}

void JumpToRange(LRESULT start, LRESULT end) {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla || start < 0 || end < start) return;
    SendMessage(scintilla, SCI_SETSEL, start, end);
    SendMessage(scintilla, SCI_SCROLLCARET, 0, 0);
    SetFocus(scintilla);
}

bool PromptText(const wchar_t* title, const wchar_t* label, std::wstring& value, size_t maximumCharacters, bool allowEmpty) {
    TextInputContext context{title, label, value, maximumCharacters, false};
    if (DialogBoxParamW(g_instance, MAKEINTRESOURCEW(kTextInputDialogId), g_nppData._nppHandle,
        TextInputDialogProcedure, reinterpret_cast<LPARAM>(&context)) != IDOK || !context.accepted) return false;
    if (!allowEmpty && context.value.find_first_not_of(L" \t\r\n") == std::wstring::npos) return false;
    value = std::move(context.value);
    return true;
}

INT_PTR CALLBACK TextInputDialogProcedure(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* context = reinterpret_cast<TextInputContext*>(GetWindowLongPtrW(dialog, GWLP_USERDATA));
    if (message == WM_INITDIALOG) {
        context = reinterpret_cast<TextInputContext*>(lParam);
        SetWindowLongPtrW(dialog, GWLP_USERDATA, lParam);
        SetWindowTextW(dialog, context->title.c_str());
        SetDlgItemTextW(dialog, kInputLabel, context->label.c_str());
        SetDlgItemTextW(dialog, kInputEdit, context->value.c_str());
        SendDlgItemMessageW(dialog, kInputEdit, EM_SETLIMITTEXT, context->maximumCharacters, 0);
        SetFocus(GetDlgItem(dialog, kInputEdit));
        return FALSE;
    }
    if (message == WM_COMMAND && LOWORD(wParam) == IDOK && context) {
        const int length = GetWindowTextLengthW(GetDlgItem(dialog, kInputEdit));
        std::wstring value(static_cast<size_t>(length) + 1, L'\0');
        GetDlgItemTextW(dialog, kInputEdit, value.data(), length + 1);
        value.resize(static_cast<size_t>(length));
        context->value = std::move(value);
        context->accepted = true;
        EndDialog(dialog, IDOK);
        return TRUE;
    }
    if (message == WM_COMMAND && LOWORD(wParam) == IDCANCEL) {
        EndDialog(dialog, IDCANCEL);
        return TRUE;
    }
    return FALSE;
}

void ShowSelectedComment() {
    CommentEntry* item = SelectedComment();
    if (!item) return;
    JumpToRange(item->start, item->end);
    const std::wstring text = L"Автор: " + Utf8ToWide(item->author) + L"\nСтатус: " + ReviewStatusLabel(item->status)
        + L"\n\n" + Utf8ToWide(item->thread);
    MessageBoxW(g_panel, text.c_str(), L"Комментарий", MB_OK | MB_ICONINFORMATION);
}

void ShowSelectedSuggestion() {
    SuggestionEntry* item = SelectedSuggestion();
    if (!item) return;
    JumpToRange(item->start, item->end);
    std::wstring text = L"Автор: " + Utf8ToWide(item->author) + L"\nСтатус: " + ReviewStatusLabel(item->status);
    if (!item->decidedBy.empty()) text += L" (" + Utf8ToWide(item->decidedBy) + L")";
    text += L"\n\nБыло:\n" + Utf8ToWide(item->original) + L"\n\nПредлагается:\n" + Utf8ToWide(item->replacement);
    if (!item->thread.empty()) text += L"\n\nОбсуждение:\n" + Utf8ToWide(item->thread);
    MessageBoxW(g_panel, text.c_str(), L"Предложение правки", MB_OK | MB_ICONINFORMATION);
}

void ReplyToSelected(const char* type, const std::string& id) {
    std::wstring body;
    if (!PromptText(L"Ответить", L"Сообщение (до 2 КиБ)", body, 1024, false)) return;
    const std::wstring path = CurrentPathWide();
    const std::string bodyUtf8 = WideToUtf8(body);
    WritePipeLine("{\"type\":\"" + std::string(type) + "\",\"path\":\"" + JsonEscape(WideToUtf8(path))
        + "\",\"id\":\"" + JsonEscape(id) + "\",\"bodyBase64\":\""
        + Base64Encode(bodyUtf8.data(), bodyUtf8.size()) + "\"}");
}

void ReplyToSelectedComment() {
    if (CommentEntry* item = SelectedComment()) ReplyToSelected("commentReply", item->id);
}

void ToggleSelectedComment() {
    CommentEntry* item = SelectedComment();
    if (!item) return;
    const char* status = item->status == "resolved" ? "open" : "resolved";
    WritePipeLine("{\"type\":\"commentStatus\",\"path\":\"" + JsonEscape(WideToUtf8(CurrentPathWide()))
        + "\",\"id\":\"" + JsonEscape(item->id) + "\",\"status\":\"" + status + "\"}");
}

void DeleteSelectedComment() {
    CommentEntry* item = SelectedComment();
    if (!item) return;
    WritePipeLine("{\"type\":\"commentDelete\",\"path\":\"" + JsonEscape(WideToUtf8(CurrentPathWide()))
        + "\",\"id\":\"" + JsonEscape(item->id) + "\"}");
}

void ReplyToSelectedSuggestion() {
    if (SuggestionEntry* item = SelectedSuggestion()) ReplyToSelected("suggestionReply", item->id);
}

void DecideSelectedSuggestion(const char* type) {
    SuggestionEntry* item = SelectedSuggestion();
    if (!item) return;
    WritePipeLine("{\"type\":\"" + std::string(type) + "\",\"path\":\"" + JsonEscape(WideToUtf8(CurrentPathWide()))
        + "\",\"id\":\"" + JsonEscape(item->id) + "\"}");
}

void DeleteSelectedSuggestion() {
    SuggestionEntry* item = SelectedSuggestion();
    if (!item) return;
    WritePipeLine("{\"type\":\"suggestionDelete\",\"path\":\"" + JsonEscape(WideToUtf8(CurrentPathWide()))
        + "\",\"id\":\"" + JsonEscape(item->id) + "\"}");
}

void DeleteSelectedReservation() {
    const LRESULT selected = SendMessageW(g_reservationsList, LB_GETCURSEL, 0, 0);
    if (selected == LB_ERR || static_cast<size_t>(selected) >= g_reservations.size()) {
        MessageBoxW(g_panel, L"Сначала выберите бронь в списке.", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    const std::wstring path = CurrentPathWide();
    if (!IsTrackedPath(path)) return;
    WritePipeLine(
        "{\"type\":\"reservationDelete\",\"path\":\"" + JsonEscape(WideToUtf8(path)) +
        "\",\"id\":\"" + JsonEscape(g_reservations[static_cast<size_t>(selected)].id) + "\"}");
}

void JumpToSelectedReservation() {
    const LRESULT selected = SendMessageW(g_reservationsList, LB_GETCURSEL, 0, 0);
    if (selected == LB_ERR || static_cast<size_t>(selected) >= g_reservations.size()) return;
    const ReservationEntry& reservation = g_reservations[static_cast<size_t>(selected)];
    const HWND scintilla = CurrentScintilla();
    SendMessage(scintilla, SCI_SETSEL, reservation.start, reservation.end);
    SendMessage(scintilla, SCI_SCROLLCARET, 0, 0);
    SetFocus(scintilla);
}

void JumpToSelectedParticipant() {
    const LRESULT selected = SendMessageW(g_participantsList, LB_GETCURSEL, 0, 0);
    if (selected == LB_ERR) return;
    const size_t localEntries = g_agentUser.empty() ? 0 : 1;
    if (static_cast<size_t>(selected) < localEntries) return;
    const size_t presenceIndex = static_cast<size_t>(selected) - localEntries;
    if (presenceIndex >= g_presences.size()) return;

    const HWND scintilla = CurrentScintilla();
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    const LRESULT position = std::clamp<LRESULT>(
        g_presences[presenceIndex].position,
        0,
        documentLength);
    SendMessage(scintilla, SCI_SETSEL, position, position);
    SendMessage(scintilla, SCI_SCROLLCARET, 0, 0);
    SetFocus(scintilla);
}

void ResolveSelectedConflict(const char* choice) {
    const LRESULT selected = SendMessageW(g_conflictsList, LB_GETCURSEL, 0, 0);
    if (selected == LB_ERR || static_cast<size_t>(selected) >= g_externalConflicts.size()) {
        MessageBoxW(g_panel, L"Сначала выберите конфликт Git в списке.", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    const std::wstring path = CurrentPathWide();
    if (!IsTrackedPath(path)) return;
    const ExternalConflictEntry& conflict = g_externalConflicts[static_cast<size_t>(selected)];
    WritePipeLine(
        "{\"type\":\"externalConflictResolve\",\"path\":\"" + JsonEscape(WideToUtf8(path)) +
        "\",\"key\":\"" + JsonEscape(conflict.key) +
        "\",\"source\":\"" + JsonEscape(conflict.source) +
        "\",\"choice\":\"" + choice + "\"}");
}

void JumpToSelectedConflict() {
    const LRESULT selected = SendMessageW(g_conflictsList, LB_GETCURSEL, 0, 0);
    if (selected == LB_ERR || static_cast<size_t>(selected) >= g_externalConflicts.size()) return;
    const std::string key = g_externalConflicts[static_cast<size_t>(selected)].key;
    if (key.empty() || key.rfind("__", 0) == 0) return;
    const std::string text = CurrentDocumentText();
    size_t position = 0;
    while (position < text.size()) {
        const size_t lineEnd = text.find('\n', position);
        const size_t contentEnd = lineEnd == std::string::npos ? text.size() : lineEnd;
        size_t keyStart = position;
        while (keyStart < contentEnd && (text[keyStart] == ' ' || text[keyStart] == '\t')) ++keyStart;
        if (
            contentEnd >= keyStart + key.size() + 1
            && text.compare(keyStart, key.size(), key) == 0
            && text[keyStart + key.size()] == ':') {
            const HWND scintilla = CurrentScintilla();
            SendMessage(scintilla, SCI_SETSEL, static_cast<WPARAM>(position), static_cast<LPARAM>(contentEnd));
            SendMessage(scintilla, SCI_SCROLLCARET, 0, 0);
            SetFocus(scintilla);
            return;
        }
        if (lineEnd == std::string::npos) break;
        position = lineEnd + 1;
    }
}

INT_PTR CALLBACK PanelDialogProcedure(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == WM_INITDIALOG) {
        g_panel = dialog;
        g_statusControl = CreatePanelControl(dialog, L"STATIC", L"", SS_LEFT, 0, kStatusControl);
        g_identityControl = CreatePanelControl(dialog, L"STATIC", L"", SS_LEFT | SS_ENDELLIPSIS, 0, kIdentityControl);
        g_fileControl = CreatePanelControl(dialog, L"STATIC", L"", SS_LEFT | SS_ENDELLIPSIS, 0, kFileControl);
        CreatePanelControl(dialog, L"STATIC", L"Участники в файле", SS_LEFT, 0, kParticipantsLabel);
        g_participantsList = CreatePanelControl(
            dialog,
            L"LISTBOX",
            L"",
            LBS_OWNERDRAWFIXED | LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT | LBS_NOTIFY | WS_VSCROLL,
            WS_EX_CLIENTEDGE,
            kParticipantsList);
        CreatePanelControl(dialog, L"STATIC", L"Брони", SS_LEFT, 0, kReservationsLabel);
        g_reservationsList = CreatePanelControl(
            dialog,
            L"LISTBOX",
            L"",
            LBS_OWNERDRAWFIXED | LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT | LBS_NOTIFY | WS_VSCROLL,
            WS_EX_CLIENTEDGE,
            kReservationsList);
        CreatePanelControl(dialog, L"STATIC", L"Комментарии", SS_LEFT, 0, kCommentsLabel);
        g_commentsList = CreatePanelControl(dialog, L"LISTBOX", L"",
            LBS_OWNERDRAWVARIABLE | LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT | LBS_NOTIFY | WS_VSCROLL, WS_EX_CLIENTEDGE, kCommentsList);
        g_commentReplyButton = CreatePanelControl(dialog, L"BUTTON", L"Ответить", BS_PUSHBUTTON, 0, kCommentReplyButton);
        g_commentStatusButton = CreatePanelControl(dialog, L"BUTTON", L"Закрыть", BS_PUSHBUTTON, 0, kCommentStatusButton);
        g_commentDeleteButton = CreatePanelControl(dialog, L"BUTTON", L"Удалить", BS_PUSHBUTTON, 0, kCommentDeleteButton);
        CreatePanelControl(dialog, L"STATIC", L"Предложения правок", SS_LEFT, 0, kSuggestionsLabel);
        CreatePanelControl(dialog, L"STATIC", L"Вид:", SS_LEFT, 0, kSuggestionDisplayLabel);
        g_suggestionDisplayCombo = CreatePanelControl(dialog, L"COMBOBOX", L"",
            CBS_DROPDOWNLIST | WS_VSCROLL, 0, kSuggestionDisplayCombo);
        SendMessageW(g_suggestionDisplayCombo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Карточки у текста"));
        SendMessageW(g_suggestionDisplayCombo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Компактно"));
        SendMessageW(g_suggestionDisplayCombo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Не показывать в тексте"));
        SendMessageW(g_suggestionDisplayCombo, CB_SETCURSEL,
            static_cast<WPARAM>(g_suggestionDisplayMode), 0);
        g_suggestionsList = CreatePanelControl(dialog, L"LISTBOX", L"",
            LBS_OWNERDRAWVARIABLE | LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT | LBS_NOTIFY | WS_VSCROLL, WS_EX_CLIENTEDGE, kSuggestionsList);
        g_suggestionReplyButton = CreatePanelControl(dialog, L"BUTTON", L"Обсудить", BS_PUSHBUTTON, 0, kSuggestionReplyButton);
        g_suggestionAcceptButton = CreatePanelControl(dialog, L"BUTTON", L"Принять", BS_PUSHBUTTON, 0, kSuggestionAcceptButton);
        g_suggestionRejectButton = CreatePanelControl(dialog, L"BUTTON", L"Отклонить", BS_PUSHBUTTON, 0, kSuggestionRejectButton);
        g_suggestionDeleteButton = CreatePanelControl(dialog, L"BUTTON", L"Удалить", BS_PUSHBUTTON, 0, kSuggestionDeleteButton);
        CreatePanelControl(dialog, L"STATIC", L"Конфликты Git", SS_LEFT, 0, kConflictsLabel);
        g_conflictsList = CreatePanelControl(
            dialog,
            L"LISTBOX",
            L"",
            LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT | LBS_NOTIFY | WS_VSCROLL,
            WS_EX_CLIENTEDGE,
            kConflictsList);
        g_keepCollaborativeButton = CreatePanelControl(
            dialog,
            L"BUTTON",
            L"Оставить текущий",
            BS_PUSHBUTTON,
            0,
            kKeepCollaborativeButton);
        g_useExternalButton = CreatePanelControl(
            dialog,
            L"BUTTON",
            L"Принять из Git",
            BS_PUSHBUTTON,
            0,
            kUseExternalButton);
        CreatePanelControl(dialog, L"STATIC", L"Бронь для:", SS_LEFT, 0, kReservationTargetLabel);
        g_reservationTargetCombo = CreatePanelControl(
            dialog,
            L"COMBOBOX",
            L"",
            CBS_DROPDOWNLIST | WS_VSCROLL,
            0,
            kReservationTargetCombo);
        g_reserveButton = CreatePanelControl(dialog, L"BUTTON", L"Забронировать", BS_PUSHBUTTON, 0, kReserveButton);
        g_deleteButton = CreatePanelControl(dialog, L"BUTTON", L"Удалить выбранную", BS_PUSHBUTTON, 0, kDeleteButton);
        LayoutPanel(dialog);
        UpdatePanel();
        return TRUE;
    }
    if (message == WM_SIZE) {
        LayoutPanel(dialog);
        return TRUE;
    }
    if (message == WM_COMMAND) {
        const int control = LOWORD(wParam);
        const int notification = HIWORD(wParam);
        if (control == kReserveButton && notification == BN_CLICKED) {
            ReserveSelection();
            return TRUE;
        }
        if (control == kDeleteButton && notification == BN_CLICKED) {
            DeleteSelectedReservation();
            return TRUE;
        }
        if (control == kParticipantsList && notification == LBN_SELCHANGE) {
            JumpToSelectedParticipant();
            return TRUE;
        }
        if (control == kReservationsList && notification == LBN_DBLCLK) {
            JumpToSelectedReservation();
            return TRUE;
        }
        if (control == kCommentsList && notification == LBN_SELCHANGE) {
            UpdatePanel();
            return TRUE;
        }
        if (control == kCommentsList && notification == LBN_DBLCLK) {
            ShowSelectedComment();
            return TRUE;
        }
        if (control == kCommentReplyButton && notification == BN_CLICKED) {
            ReplyToSelectedComment();
            return TRUE;
        }
        if (control == kCommentStatusButton && notification == BN_CLICKED) {
            ToggleSelectedComment();
            return TRUE;
        }
        if (control == kCommentDeleteButton && notification == BN_CLICKED) {
            DeleteSelectedComment();
            return TRUE;
        }
        if (control == kSuggestionsList && notification == LBN_SELCHANGE) {
            UpdatePanel();
            return TRUE;
        }
        if (control == kSuggestionDisplayCombo && notification == CBN_SELCHANGE) {
            const LRESULT selected = SendMessageW(g_suggestionDisplayCombo, CB_GETCURSEL, 0, 0);
            if (selected >= 0 && selected <= 2) {
                g_suggestionDisplayMode = static_cast<SuggestionDisplayMode>(selected);
                g_hoveredSuggestionIds.clear();
                g_suggestionOverlayHits.clear();
                RefreshSuggestionVisuals();
            }
            return TRUE;
        }
        if (control == kSuggestionsList && notification == LBN_DBLCLK) {
            ShowSelectedSuggestion();
            return TRUE;
        }
        if (control == kSuggestionReplyButton && notification == BN_CLICKED) {
            ReplyToSelectedSuggestion();
            return TRUE;
        }
        if (control == kSuggestionAcceptButton && notification == BN_CLICKED) {
            DecideSelectedSuggestion("suggestionAccept");
            return TRUE;
        }
        if (control == kSuggestionRejectButton && notification == BN_CLICKED) {
            DecideSelectedSuggestion("suggestionReject");
            return TRUE;
        }
        if (control == kSuggestionDeleteButton && notification == BN_CLICKED) {
            DeleteSelectedSuggestion();
            return TRUE;
        }
        if (control == kKeepCollaborativeButton && notification == BN_CLICKED) {
            ResolveSelectedConflict("collaborative");
            return TRUE;
        }
        if (control == kUseExternalButton && notification == BN_CLICKED) {
            ResolveSelectedConflict("external");
            return TRUE;
        }
        if (control == kConflictsList && notification == LBN_DBLCLK) {
            JumpToSelectedConflict();
            return TRUE;
        }
        return FALSE;
    }
    if (message == WM_MEASUREITEM) {
        auto* item = reinterpret_cast<MEASUREITEMSTRUCT*>(lParam);
        if (item && (item->CtlID == kCommentsList || item->CtlID == kSuggestionsList)) {
            item->itemHeight = 50;
            return TRUE;
        }
    }
    if (message == WM_DRAWITEM) {
        const auto* item = reinterpret_cast<DRAWITEMSTRUCT*>(lParam);
        if (!item || (item->CtlID != kParticipantsList && item->CtlID != kReservationsList
            && item->CtlID != kCommentsList && item->CtlID != kSuggestionsList)
            || item->itemID == static_cast<UINT>(-1)) {
            return FALSE;
        }
        if (item->CtlID == kCommentsList || item->CtlID == kSuggestionsList) {
            const bool selected = (item->itemState & ODS_SELECTED) != 0;
            const COLORREF background = GetSysColor(selected ? COLOR_HIGHLIGHT : COLOR_WINDOW);
            HBRUSH backgroundBrush = CreateSolidBrush(background);
            FillRect(item->hDC, &item->rcItem, backgroundBrush);
            DeleteObject(backgroundBrush);
            RECT card = item->rcItem;
            InflateRect(&card, -2, -2);
            FrameRect(item->hDC, &card, GetSysColorBrush(selected ? COLOR_HIGHLIGHT : COLOR_3DLIGHT));
            RECT strip{card.left, card.top, card.left + 5, card.bottom};
            HBRUSH colourBrush = CreateSolidBrush(static_cast<COLORREF>(item->itemData));
            FillRect(item->hDC, &strip, colourBrush);
            DeleteObject(colourBrush);

            std::wstring title;
            std::wstring body;
            COLORREF titleColour = static_cast<COLORREF>(item->itemData);
            COLORREF bodyColour = titleColour;
            if (item->CtlID == kCommentsList && item->itemID < g_comments.size()) {
                const CommentEntry& entry = g_comments[item->itemID];
                const LRESULT line = SendMessage(CurrentScintilla(), SCI_LINEFROMPOSITION, entry.start, 0) + 1;
                title = Utf8ToWide(entry.author) + L" · строка " + std::to_wstring(line)
                    + L" · " + ReviewStatusLabel(entry.status)
                    + L" · " + std::to_wstring(entry.messageCount) + L" сообщ.";
                body = Utf8ToWide(entry.summaryAuthor) + L": " + OneLine(Utf8ToWide(entry.summary), 110);
                bodyColour = ColorFromString(entry.summaryColor, titleColour);
            } else if (item->CtlID == kSuggestionsList && item->itemID < g_suggestions.size()) {
                const SuggestionEntry& entry = g_suggestions[item->itemID];
                const LRESULT line = SendMessage(CurrentScintilla(), SCI_LINEFROMPOSITION, entry.start, 0) + 1;
                title = Utf8ToWide(entry.author) + L" · строка " + std::to_wstring(line)
                    + L" · " + ReviewStatusLabel(entry.status);
                body = OneLine(Utf8ToWide(entry.original), 52) + L" → " + OneLine(Utf8ToWide(entry.replacement), 52);
            }
            if (selected) titleColour = bodyColour = GetSysColor(COLOR_HIGHLIGHTTEXT);
            SetBkMode(item->hDC, TRANSPARENT);
            RECT titleRect{card.left + 10, card.top + 3, card.right - 4, card.top + 21};
            SetTextColor(item->hDC, selected ? titleColour : ReadableAnnotationColor(titleColour));
            DrawTextW(item->hDC, title.c_str(), -1, &titleRect, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
            RECT bodyRect{card.left + 10, card.top + 22, card.right - 4, card.bottom - 2};
            SetTextColor(item->hDC, selected ? bodyColour : ReadableAnnotationColor(bodyColour));
            const auto& messages = item->CtlID == kCommentsList
                ? g_commentMessages[g_comments[item->itemID].id]
                : g_suggestionMessages[g_suggestions[item->itemID].id];
            if (item->CtlID == kSuggestionsList || messages.empty()) {
                DrawTextW(item->hDC, body.c_str(), -1, &bodyRect, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
            }
            int messageY = card.top + (item->CtlID == kCommentsList ? 22 : 41);
            const size_t messageLimit = item->CtlID == kCommentsList ? 4 : 3;
            for (size_t index = 0; index < std::min(messages.size(), messageLimit); ++index) {
                const DiscussionEntry& discussion = messages[index];
                const std::wstring row = Utf8ToWide(discussion.author) + L": " + OneLine(Utf8ToWide(discussion.body), 105);
                RECT rowRect{card.left + 14, messageY, card.right - 4, messageY + 18};
                COLORREF rowColour = selected ? GetSysColor(COLOR_HIGHLIGHTTEXT)
                    : ReadableAnnotationColor(ColorFromString(discussion.color, titleColour));
                SetTextColor(item->hDC, rowColour);
                DrawTextW(item->hDC, row.c_str(), -1, &rowRect, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
                messageY += 18;
            }
            if (item->itemState & ODS_FOCUS) DrawFocusRect(item->hDC, &item->rcItem);
            return TRUE;
        }
        const bool selected = (item->itemState & ODS_SELECTED) != 0;
        const COLORREF background = GetSysColor(selected ? COLOR_HIGHLIGHT : COLOR_WINDOW);
        const COLORREF foreground = GetSysColor(selected ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT);
        HBRUSH backgroundBrush = CreateSolidBrush(background);
        FillRect(item->hDC, &item->rcItem, backgroundBrush);
        DeleteObject(backgroundBrush);

        RECT swatch = item->rcItem;
        swatch.left += 6;
        swatch.right = swatch.left + 10;
        swatch.top += std::max(2L, (swatch.bottom - swatch.top - 10) / 2);
        swatch.bottom = swatch.top + 10;
        HBRUSH colorBrush = CreateSolidBrush(static_cast<COLORREF>(item->itemData));
        FillRect(item->hDC, &swatch, colorBrush);
        DeleteObject(colorBrush);

        wchar_t text[1024]{};
        SendMessageW(item->hwndItem, LB_GETTEXT, item->itemID, reinterpret_cast<LPARAM>(text));
        RECT textRect = item->rcItem;
        textRect.left += 22;
        SetBkMode(item->hDC, TRANSPARENT);
        SetTextColor(item->hDC, foreground);
        DrawTextW(item->hDC, text, -1, &textRect, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
        if (item->itemState & ODS_FOCUS) DrawFocusRect(item->hDC, &item->rcItem);
        return TRUE;
    }
    if (message == WM_DESTROY) {
        if (g_panel == dialog) {
            g_panel = nullptr;
            g_statusControl = nullptr;
            g_identityControl = nullptr;
            g_fileControl = nullptr;
            g_participantsList = nullptr;
            g_reservationsList = nullptr;
            g_reservationTargetCombo = nullptr;
            g_reserveButton = nullptr;
            g_deleteButton = nullptr;
            g_conflictsList = nullptr;
            g_keepCollaborativeButton = nullptr;
            g_useExternalButton = nullptr;
            g_commentsList = nullptr;
            g_commentReplyButton = nullptr;
            g_commentStatusButton = nullptr;
            g_commentDeleteButton = nullptr;
            g_suggestionsList = nullptr;
            g_suggestionReplyButton = nullptr;
            g_suggestionAcceptButton = nullptr;
            g_suggestionRejectButton = nullptr;
            g_suggestionDeleteButton = nullptr;
            g_suggestionDisplayCombo = nullptr;
        }
    }
    return FALSE;
}

void EnsurePanel(bool show) {
    if (!g_panel) {
        HWND panel = CreateDialogParamW(
            g_instance,
            MAKEINTRESOURCEW(kPanelDialogId),
            g_nppData._nppHandle,
            PanelDialogProcedure,
            0);
        if (!panel) return;
        g_panelDockData = {};
        g_panelDockData.hClient = panel;
        g_panelDockData.pszName = L"Правки и комментарии";
        g_panelDockData.dlgID = g_functions[1]._cmdID;
        g_panelDockData.uMask = DWS_DF_CONT_LEFT;
        g_panelDockData.pszAddInfo = L"EaW Hub 0.8.7F1";
        g_panelDockData.pszModuleName = L"EawLocalisationHub.dll";
        SendMessageW(
            g_nppData._nppHandle,
            NPPM_DMMREGASDCKDLG,
            0,
            reinterpret_cast<LPARAM>(&g_panelDockData));
    }
    UpdatePanel();
    if (show && g_panel) {
        SendMessageW(g_nppData._nppHandle, NPPM_DMMSHOW, 0, reinterpret_cast<LPARAM>(g_panel));
    }
}

void WritePipeLine(const std::string& message, bool priority) {
    if (!g_outboundLockInitialised.load() || (!priority && (!g_ipcAuthenticated.load() || !g_lifecycle.Connected()))) return;
    EnterCriticalSection(&g_outboundLock);
    if (g_outbound.size() < 2048) {
        if (priority) g_outbound.push_front(message + "\n");
        else g_outbound.push_back(message + "\n");
        SetEvent(g_writeEvent);
    }
    LeaveCriticalSection(&g_outboundLock);
}

void SetIndicatorStyle(HWND scintilla, int indicator, int style, COLORREF color, int alpha) {
    SendMessage(scintilla, SCI_INDICSETSTYLE, indicator, style);
    SendMessage(scintilla, SCI_INDICSETFORE, indicator, color);
    SendMessage(scintilla, SCI_INDICSETALPHA, indicator, alpha);
    SendMessage(scintilla, SCI_INDICSETOUTLINEALPHA, indicator, std::min(255, alpha * 2));
}

void ClearIndicator(int indicator) {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    const LRESULT length = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    SendMessage(scintilla, SCI_SETINDICATORCURRENT, indicator, 0);
    SendMessage(scintilla, SCI_INDICATORCLEARRANGE, 0, length);
}

void FillIndicator(int indicator, LRESULT start, LRESULT end) {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    start = std::clamp<LRESULT>(start, 0, documentLength);
    end = std::clamp<LRESULT>(end, 0, documentLength);
    if (end <= start) {
        if (start < documentLength) end = start + 1;
        else if (start > 0) --start;
    }
    SendMessage(scintilla, SCI_SETINDICATORCURRENT, indicator, 0);
    SendMessage(scintilla, SCI_INDICATORFILLRANGE, start, std::max<LRESULT>(1, end - start));
}

void FillIndicatorColored(int indicator, LRESULT start, LRESULT end, COLORREF color) {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    start = std::clamp<LRESULT>(start, 0, documentLength);
    end = std::clamp<LRESULT>(end, 0, documentLength);
    if (end <= start) {
        if (start < documentLength) end = start + 1;
        else if (start > 0) --start;
    }
    SendMessage(scintilla, SCI_SETINDICATORCURRENT, indicator, 0);
    SendMessage(scintilla, SCI_SETINDICATORVALUE, SC_INDICVALUEBIT | (color & 0xFFFFFF), 0);
    SendMessage(scintilla, SCI_INDICATORFILLRANGE, start, std::max<LRESULT>(1, end - start));
}

void RefreshPresenceVisuals() {
    ClearIndicator(kPresenceIndicator);
    for (const PresenceEntry& presence : g_presences) {
        if (presence.position == presence.anchor) continue;
        FillIndicatorColored(
            kPresenceIndicator,
            std::min(presence.position, presence.anchor),
            std::max(presence.position, presence.anchor),
            ColorFromString(presence.color, RGB(255, 145, 55)));
    }
    InvalidatePresenceOverlays();
}
void RefreshSuggestionVisuals() {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    ClearIndicator(kSuggestionIndicator);
    SendMessage(scintilla, SCI_ANNOTATIONCLEARALL, 0, 0);
    SendMessage(scintilla, SCI_ANNOTATIONSETVISIBLE, ANNOTATION_HIDDEN, 0);
    SendMessage(scintilla, SCI_EOLANNOTATIONCLEARALL, 0, 0);
    SendMessage(scintilla, SCI_EOLANNOTATIONSETVISIBLE, EOLANNOTATION_HIDDEN, 0);
    if (g_suggestionDisplayMode != SuggestionDisplayMode::Hidden) {
        for (const SuggestionEntry& suggestion : g_suggestions) {
            if (suggestion.status != "open" && suggestion.status != "stale") continue;
            FillIndicatorColored(
                kSuggestionIndicator,
                suggestion.start,
                suggestion.end,
                ColorFromString(suggestion.color, RGB(50, 175, 100)));
        }
    }
    InvalidatePresenceOverlays();
}

void ApplyRemoteReplace(LRESULT position, LRESULT deleteLength, const std::string& inserted, bool diskSynchronized = false) {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return;
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    if (position < 0 || deleteLength < 0 || position > documentLength
        || deleteLength > documentLength - position || inserted.size() > kMaximumIpcMessageBytes) {
        return;
    }
    g_applyingRemote.store(true);
    SendMessage(scintilla, SCI_SETUNDOCOLLECTION, FALSE, 0);
    if (deleteLength > 0) SendMessage(scintilla, SCI_DELETERANGE, position, deleteLength);
    if (!inserted.empty()) SendMessage(scintilla, SCI_INSERTTEXT, position, reinterpret_cast<LPARAM>(inserted.c_str()));
    SendMessage(scintilla, SCI_SETUNDOCOLLECTION, TRUE, 0);
    SendMessage(scintilla, SCI_EMPTYUNDOBUFFER, 0, 0);
    if (diskSynchronized) SendMessage(scintilla, SCI_SETSAVEPOINT, 0, 0);
    else SendMessageW(g_nppData._nppHandle, NPPM_MAKECURRENTBUFFERDIRTY, 0, 0);
    g_applyingRemote.store(false);
    if (!diskSynchronized) ScheduleAutoSave();
}
void HandleAgentLine(const std::string& json) {
    std::string protocolError;
    const auto parsed = eaw::protocol::Message::Parse(json, protocolError);
    if (!parsed) {
        g_lastNotice = "Agent IPC message rejected: " + protocolError;
        return;
    }
    const auto& message = *parsed;
    const std::string& type = message.Type();
    if (type == "ipcChallenge") {
        const std::string nonce = message.String("nonce");
        const std::string agentProof = message.String("agentProof");
        if (message.Integer("protocol", 0) != kProtocolVersion || nonce.size() != 64
            || !ConstantTimeHexEqual(agentProof, HmacSha256(g_ipcSecret, "agent:" + nonce))) {
            return;
        }
        EnterCriticalSection(&g_outboundLock); g_outbound.clear(); ResetEvent(g_writeEvent); LeaveCriticalSection(&g_outboundLock); g_ipcAuthenticated.store(true);
        WritePipeLine(
            "{\"type\":\"hello\",\"clientId\":\"" + JsonEscape(g_clientId)
            + "\",\"version\":\"0.8.6F3\",\"protocol\":" + std::to_string(kProtocolVersion) + ",\"proof\":\""
            + HmacSha256(g_ipcSecret, "plugin:" + nonce) + "\"}",
            true);
        SetEvent(g_writeEvent);
        return;
    }
    if (!g_ipcAuthenticated.load()) return;
    if (type == "agentHello") {
        g_agentUser = message.String("user");
        g_agentUserId = message.String("userId");
        g_agentColor = message.String("color");
        if (g_agentColor.empty()) g_agentColor = "#6aa9ff";
        g_workspace = message.String("workspace");
        g_lifecycle.AgentHello();
        g_externalConflicts.clear();
        if (g_lifecycle.Connect()) {
            PostMessageW(g_nppData._nppHandle, kConnectedMessage, 0, 0);
        }
        UpdatePanel();
    } else if (type == "documentStatus" && MessageMatchesCurrentPath(message)) {
        g_lifecycle.SetDocumentStatus(message.String("status"));
        g_documentStatusMessage = message.String("message");
        UpdatePanel();
    } else if (type == "documentReady" && MessageMatchesCurrentPath(message)) {
        g_lifecycle.DocumentReady();
        g_lastCursorPath.clear();
        g_lastCursorPosition = -1;
        g_lastCursorAnchor = -1;
        UpdatePanel();
        SendCursor();
        if (SendMessage(CurrentScintilla(), SCI_GETMODIFY, 0, 0)) ScheduleAutoSave();
    } else if (type == "workspaceChanged") {
        if (message.String("phase") == "ready") g_lifecycle.WorkspaceAvailable();
        else {
            g_lifecycle.WorkspaceChanged();
            g_externalConflicts.clear();
        }
        g_saveDueAt = 0;
        g_lastNotice = message.String("message");
        UpdatePanel();
    } else if (type == "externalConflictReset" && MessageMatchesCurrentPath(message)) {
        const std::string source = message.String("source");
        if (source.empty()) g_externalConflicts.clear();
        else std::erase_if(g_externalConflicts,
            [&](const ExternalConflictEntry& item) { return item.source == source; });
        UpdatePanel();
    } else if (type == "externalConflict" && MessageMatchesCurrentPath(message)) {
        ExternalConflictEntry entry{
            message.String("key"),
            message.String("label"),
            message.String("detail"),
            message.String("source"),
        };
        if (entry.source.empty()) entry.source = "disk";
        const auto existing = std::find_if(
            g_externalConflicts.begin(),
            g_externalConflicts.end(),
            [&](const ExternalConflictEntry& item) {
                return item.key == entry.key && item.source == entry.source;
            });
        if (existing == g_externalConflicts.end()) g_externalConflicts.push_back(entry);
        else *existing = entry;
        g_saveDueAt = 0;
        UpdatePanel();
    } else if (type == "saveRequested" && MessageMatchesCurrentPath(message)) {
        ScheduleAutoSave(true);
    } else if (type == "replace" && MessageMatchesCurrentPath(message)) {
        const LRESULT position = static_cast<LRESULT>(message.Integer("positionByte"));
        const LRESULT deleteLength = static_cast<LRESULT>(message.Integer("deleteBytes"));
        ApplyRemoteReplace(position, deleteLength, Base64Decode(message.String("insertBase64")),
            message.String("source") == "workspace");
    } else if (type == "reservationReset" && MessageMatchesCurrentPath(message)) {
        ClearIndicator(kReservationIndicator);
        g_reservations.clear();
        ClearReservationHover();
        UpdatePanel();
    } else if (type == "reservationTargetReset" && MessageMatchesCurrentPath(message)) {
        g_reservationTargets.clear();
        UpdatePanel();
    } else if (type == "reservationTarget" && MessageMatchesCurrentPath(message)) {
        ReservationTargetEntry target{
            message.String("id"),
            message.String("displayName"),
            message.String("color"),
        };
        const auto existing = std::find_if(
            g_reservationTargets.begin(),
            g_reservationTargets.end(),
            [&](const ReservationTargetEntry& item) {
                return !target.id.empty() ? item.id == target.id : item.id.empty() && item.displayName == target.displayName;
            });
        if (existing == g_reservationTargets.end()) g_reservationTargets.push_back(std::move(target));
        else *existing = std::move(target);
        UpdatePanel();
    } else if (type == "reservation" && MessageMatchesCurrentPath(message)) {
        ReservationEntry entry{
            message.String("id"),
            message.String("assigneeId"),
            message.String("assignee"),
            message.String("color"),
            message.String("createdById"),
            message.String("createdBy"),
            message.String("status"),
            message.String("comment"),
            static_cast<LRESULT>(message.Integer("startByte")),
            static_cast<LRESULT>(message.Integer("endByte")),
            message.Integer("keyCount"),
        };
        const auto existing = std::find_if(
            g_reservations.begin(),
            g_reservations.end(),
            [&](const ReservationEntry& item) { return item.id == entry.id; });
        if (existing == g_reservations.end()) g_reservations.push_back(entry);
        else *existing = entry;
        if (entry.status != "orphaned") {
            FillIndicatorColored(
                kReservationIndicator,
                entry.start,
                entry.end,
                ColorFromString(entry.color));
        }
        UpdatePanel();
    } else if (type == "commentReset" && MessageMatchesCurrentPath(message)) {
        ClearIndicator(kCommentIndicator);
        g_comments.clear();
        g_commentMessages.clear();
        UpdatePanel();
    } else if (type == "commentThread" && MessageMatchesCurrentPath(message)) {
        CommentEntry entry{
            message.String("id"),
            message.String("author"),
            message.String("color"),
            message.String("status"),
            Base64Decode(message.String("summaryBase64")),
            message.String("summaryAuthor"),
            message.String("summaryColor"),
            Base64Decode(message.String("threadBase64")),
            static_cast<LRESULT>(message.Integer("startByte")),
            static_cast<LRESULT>(message.Integer("endByte")),
            message.Integer("messageCount"),
        };
        const auto existing = std::find_if(g_comments.begin(), g_comments.end(),
            [&](const CommentEntry& item) { return item.id == entry.id; });
        if (existing == g_comments.end()) g_comments.push_back(entry);
        else *existing = entry;
        if (entry.status == "open") FillIndicatorColored(
            kCommentIndicator, entry.start, entry.end, ColorFromString(entry.color, RGB(235, 175, 35)));
        UpdatePanel();
    } else if (type == "commentMessage" && MessageMatchesCurrentPath(message)) {
        g_commentMessages[message.String("id")].push_back({
            message.String("author"), message.String("color"), Base64Decode(message.String("bodyBase64")),
        });
        UpdatePanel();
    } else if (type == "suggestionReset" && MessageMatchesCurrentPath(message)) {
        g_suggestions.clear();
        g_suggestionMessages.clear();
        g_suggestionOverlayHits.clear();
        g_hoveredSuggestionIds.clear();
        RefreshSuggestionVisuals();
        UpdatePanel();
    } else if (type == "suggestion" && MessageMatchesCurrentPath(message)) {
        SuggestionEntry entry{
            message.String("id"),
            message.String("author"),
            message.String("color"),
            message.String("decidedBy"),
            message.String("status"),
            Base64Decode(message.String("originalBase64")),
            Base64Decode(message.String("replacementBase64")),
            Base64Decode(message.String("threadBase64")),
            static_cast<LRESULT>(message.Integer("startByte")),
            static_cast<LRESULT>(message.Integer("endByte")),
            message.Integer("messageCount"),
        };
        const auto existing = std::find_if(g_suggestions.begin(), g_suggestions.end(),
            [&](const SuggestionEntry& item) { return item.id == entry.id; });
        if (existing == g_suggestions.end()) g_suggestions.push_back(entry);
        else *existing = entry;
        RefreshSuggestionVisuals();
        UpdatePanel();
    } else if (type == "suggestionMessage" && MessageMatchesCurrentPath(message)) {
        g_suggestionMessages[message.String("id")].push_back({
            message.String("author"), message.String("color"), Base64Decode(message.String("bodyBase64")),
        });
        UpdatePanel();
    } else if (type == "presenceReset" && MessageMatchesCurrentPath(message)) {
        g_presences.clear();
        g_presenceOverlayHits.clear();
        g_hoveredPresenceIds.clear();
        g_suggestionOverlayHits.clear();
        g_hoveredSuggestionIds.clear();
        RefreshPresenceVisuals();
        UpdatePanel();
    } else if (type == "presence" && MessageMatchesCurrentPath(message)) {
        PresenceEntry entry{
            message.String("clientId"),
            message.String("user"),
            message.String("color"),
            static_cast<LRESULT>(message.Integer("positionByte")),
            static_cast<LRESULT>(message.Integer("anchorByte", message.Integer("positionByte"))),
        };
        const auto existing = std::find_if(
            g_presences.begin(),
            g_presences.end(),
            [&](const PresenceEntry& item) { return item.clientId == entry.clientId; });
        if (existing == g_presences.end()) g_presences.push_back(entry);
        else *existing = entry;
        RefreshPresenceVisuals();
        UpdatePanel();
    } else if (type == "error") {
        const std::wstring errorMessage = Utf8ToWide(message.String("message"));
        MessageBoxW(g_nppData._nppHandle, errorMessage.c_str(), kPluginName, MB_OK | MB_ICONERROR);
    } else if (type == "notice") {
        g_lastNotice = message.String("message");
        if (g_panel) UpdatePanel();
        else {
            const std::wstring message = Utf8ToWide(g_lastNotice);
            MessageBoxW(g_nppData._nppHandle, message.c_str(), kPluginName, MB_OK | MB_ICONINFORMATION);
        }
    }
}

DWORD WINAPI PipeThreadProcedure(LPVOID) {
    while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
        g_ipcSecret = ReadIpcSecret();
        if (g_ipcSecret.size() >= 32 && g_ipcSecret.size() <= 256) break;
        if (WaitForSingleObject(g_stopEvent, 500) == WAIT_OBJECT_0) return 0;
    }
    wchar_t configuredName[256]{};
    DWORD configuredLength = GetEnvironmentVariableW(L"EAW_HUB_PIPE", configuredName, static_cast<DWORD>(std::size(configuredName)));
    const std::wstring pipeName = configuredLength > 0 && configuredLength < std::size(configuredName)
        ? configuredName
        : DerivedPipeName(g_ipcSecret);
    if (pipeName.empty()) return 0;
    const std::wstring pipePath = L"\\\\.\\pipe\\" + pipeName;
    while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
        if (!WaitNamedPipeW(pipePath.c_str(), 500)) { WaitForSingleObject(g_stopEvent, 250); continue; }
        HANDLE pipe = CreateFileW(
            pipePath.c_str(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            nullptr,
            OPEN_EXISTING,
            0,
            nullptr);
        if (pipe == INVALID_HANDLE_VALUE) { WaitForSingleObject(g_stopEvent, 100); continue; }
        g_lifecycle.Disconnect();
        g_ipcAuthenticated.store(false);
        EnterCriticalSection(&g_outboundLock); g_outbound.clear(); ResetEvent(g_writeEvent); LeaveCriticalSection(&g_outboundLock);
        EnterCriticalSection(&g_pipeLock);
        g_pipe = pipe;
        LeaveCriticalSection(&g_pipeLock);
        std::string pending;
        char buffer[8192];
        while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
            DWORD available = 0;
            if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) break;
            if (available == 0) {
                if (WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
                continue;
            }
            DWORD bytesRead = 0;
            const DWORD requested = std::min<DWORD>(available, static_cast<DWORD>(sizeof(buffer)));
            if (!ReadFile(pipe, buffer, requested, &bytesRead, nullptr) || bytesRead == 0) break;
            pending.append(buffer, bytesRead);
            if (pending.size() > kMaximumIpcMessageBytes) break;
            while (true) {
                const size_t newline = pending.find('\n');
                if (newline == std::string::npos) break;
                auto line = std::make_unique<std::string>(pending.substr(0, newline));
                pending.erase(0, newline + 1);
                PostMessageW(g_nppData._nppHandle, kIncomingMessage, 0, reinterpret_cast<LPARAM>(line.release()));
            }
        }

        EnterCriticalSection(&g_pipeLock);
        if (g_pipe == pipe) g_pipe = INVALID_HANDLE_VALUE;
        LeaveCriticalSection(&g_pipeLock);
        g_lifecycle.Disconnect();
        g_ipcAuthenticated.store(false);
        CloseHandle(pipe);
        PostMessageW(g_nppData._nppHandle, kDisconnectedMessage, 0, 0);
    }
    return 0;
}

DWORD WINAPI WriterThreadProcedure(LPVOID) {
    HANDLE waitHandles[] = {g_stopEvent, g_writeEvent};
    while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
        const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
        if (waitResult == WAIT_OBJECT_0) break;
        if (waitResult != WAIT_OBJECT_0 + 1) continue;

        while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
            if (!g_ipcAuthenticated.load()) { ResetEvent(g_writeEvent); break; }
            std::string line;
            EnterCriticalSection(&g_outboundLock);
            if (g_outbound.empty()) {
                ResetEvent(g_writeEvent);
            } else {
                line = std::move(g_outbound.front());
                g_outbound.pop_front();
            }
            LeaveCriticalSection(&g_outboundLock);
            if (line.empty()) break;

            HANDLE pipeCopy = INVALID_HANDLE_VALUE;
            EnterCriticalSection(&g_pipeLock);
            if (g_pipe != INVALID_HANDLE_VALUE) {
                DuplicateHandle(
                    GetCurrentProcess(), g_pipe,
                    GetCurrentProcess(), &pipeCopy,
                    0, FALSE, DUPLICATE_SAME_ACCESS);
            }
            LeaveCriticalSection(&g_pipeLock);
            if (pipeCopy == INVALID_HANDLE_VALUE) {
                EnterCriticalSection(&g_outboundLock);
                g_outbound.push_front(std::move(line));
                LeaveCriticalSection(&g_outboundLock);
                if (WaitForSingleObject(g_stopEvent, 100) == WAIT_OBJECT_0) break;
                continue;
            }

            DWORD written = 0;
            WriteFile(pipeCopy, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
            CloseHandle(pipeCopy);
        }
    }
    return 0;
}

LRESULT CALLBACK MainSubclassProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR) {
    static const UINT testCreateSuggestionMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestCreateSuggestion.0.6.5");
    static const UINT testCreateCommentMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestCreateComment.0.6.5");
    if (message == testCreateSuggestionMessage) {
        const std::wstring path = CurrentPathWide();
        const std::string text = CurrentDocumentText();
        const std::string original = "\"One\"";
        const size_t start = text.find(original);
        if (!IsTrackedPath(path) || start == std::string::npos || !g_lifecycle.Ready()) return 0;
        const std::string replacement = "\"Proposed\"";
        WritePipeLine("{\"type\":\"suggestionCreate\",\"path\":\"" + JsonEscape(WideToUtf8(path))
            + "\",\"startByte\":" + std::to_string(start) + ",\"endByte\":" + std::to_string(start + original.size())
            + ",\"replacementBase64\":\"" + Base64Encode(replacement.data(), replacement.size()) + "\"}");
        return 1;
    }
    if (message == testCreateCommentMessage) {
        const std::wstring path = CurrentPathWide();
        const std::string text = CurrentDocumentText();
        const std::string original = "\"Two\"";
        const size_t start = text.find(original);
        if (!IsTrackedPath(path) || start == std::string::npos || !g_lifecycle.Ready()) return 0;
        const std::string body = "Live comment card";
        WritePipeLine("{\"type\":\"commentCreate\",\"path\":\"" + JsonEscape(WideToUtf8(path))
            + "\",\"startByte\":" + std::to_string(start) + ",\"endByte\":" + std::to_string(start + original.size())
            + ",\"bodyBase64\":\"" + Base64Encode(body.data(), body.size()) + "\"}");
        return 1;
    }
    if (message == kIncomingMessage) {
        std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(lParam));
        if (line) HandleAgentLine(*line);
        return 0;
    }
    if (message == kConnectedMessage) {
        if (!g_integrationEnabled) {
            if (!g_pendingReviewPath.empty()) {
                WritePipeLine("{\"type\":\"reviewOpen\",\"path\":\"" + JsonEscape(g_pendingReviewPath) + "\"}"); g_pendingReviewPath.clear();
            }
            return 0;
        }
        g_lifecycle.DocumentClosed();
        UpdatePanel();
        SendCurrentDocument();
        return 0;
    }
    if (message == kDisconnectedMessage) {
        g_lifecycle.SetDocumentStatus("offline");
        UpdatePanel();
        return 0;
    }
    if (message == WM_TIMER && wParam == kObserverTimerId) {
        PollCurrentDocument();
        MaybeAutoSave();
        return 0;
    }
    return DefSubclassProc(window, message, wParam, lParam);
}

LRESULT CALLBACK ScintillaSubclassProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR) {
    static const UINT testHoverMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestHoverPresence.0.4");
    static const UINT testReservationHoverMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestHoverReservation.0.6.5");
    static const UINT testPresenceLabelVisibleMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestPresenceLabelVisible.0.6.5");
    static const UINT testSuggestionGhostVisibleMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestSuggestionGhostVisible.0.6.5");
    if (message == testPresenceLabelVisibleMessage) return g_hoveredPresenceIds.empty() ? 0 : 1;
    if (message == testSuggestionGhostVisibleMessage) {
        return g_suggestionDisplayMode != SuggestionDisplayMode::Hidden
            && std::any_of(g_suggestions.begin(), g_suggestions.end(), [](const SuggestionEntry& suggestion) {
            return suggestion.status == "open" || suggestion.status == "stale";
        }) ? 1 : 0;
    }
    if (message == testHoverMessage) {
        const LRESULT position = SendMessage(window, SCI_GETCURRENTPOS, 0, 0);
        POINT point{
            static_cast<LONG>(SendMessage(window, SCI_POINTXFROMPOSITION, 0, position)),
            static_cast<LONG>(SendMessage(window, SCI_POINTYFROMPOSITION, 0, position) + 5)};
        UpdatePresenceHover(window, point);
        RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        return 1;
    }
    if (message == testReservationHoverMessage) {
        if (g_reservations.empty()) return 0;
        const LRESULT position = g_reservations.front().start;
        POINT point{
            static_cast<LONG>(SendMessage(window, SCI_POINTXFROMPOSITION, 0, position)),
            static_cast<LONG>(SendMessage(window, SCI_POINTYFROMPOSITION, 0, position) + 5)};
        UpdateReservationHover(window, point);
        RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        return 1;
    }
    if (message == WM_MOUSEMOVE) {
        TRACKMOUSEEVENT tracking{sizeof(TRACKMOUSEEVENT), TME_LEAVE, window, 0};
        TrackMouseEvent(&tracking);
        POINT point{
            static_cast<short>(LOWORD(lParam)),
            static_cast<short>(HIWORD(lParam))};
        UpdatePresenceHover(window, point);
        UpdateSuggestionHover(window, point);
        UpdateReservationHover(window, point);
    } else if (message == WM_MOUSELEAVE) {
        ClearPresenceHover();
        ClearSuggestionHover();
        ClearReservationHover();
    } else if (message == WM_MOUSEWHEEL || message == WM_VSCROLL || message == WM_HSCROLL) {
        ClearPresenceHover();
        ClearSuggestionHover();
        ClearReservationHover();
    }
    const LRESULT result = DefSubclassProc(window, message, wParam, lParam);
    if (message == WM_PAINT) {
        eaw::overlays::DrawSuggestionGhosts(
            window,
            CurrentScintilla(),
            g_suggestions,
            g_suggestionDisplayMode,
            g_suggestionOverlayHits,
            g_hoveredSuggestionIds);
        DrawPresenceOverlays(window);
        DrawReservationHover(window);
    }
    return result;
}

void StartTransport(bool reviewOnly = false) {
    if (g_started.exchange(true)) return;
    InitializeCriticalSection(&g_pipeLock);
    g_lockInitialised.store(true);
    InitializeCriticalSection(&g_outboundLock);
    g_outboundLockInitialised.store(true);
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const DWORD pid = GetCurrentProcessId();
    g_clientId = "npp-" + std::to_string(pid) + "-" + std::to_string(GetTickCount64());
    SetWindowSubclass(g_nppData._nppHandle, MainSubclassProcedure, kMainSubclassId, 0);
    if (!reviewOnly) {
    SetWindowSubclass(g_nppData._scintillaMainHandle, ScintillaSubclassProcedure, kScintillaSubclassId, 0);
    SetWindowSubclass(g_nppData._scintillaSecondHandle, ScintillaSubclassProcedure, kScintillaSubclassId, 0);
    SetTimer(g_nppData._nppHandle, kObserverTimerId, 250, nullptr);

    SetIndicatorStyle(g_nppData._scintillaMainHandle, kReservationIndicator, INDIC_ROUNDBOX, RGB(70, 135, 255), 80);
    SetIndicatorStyle(g_nppData._scintillaSecondHandle, kReservationIndicator, INDIC_ROUNDBOX, RGB(70, 135, 255), 80);
    SendMessage(g_nppData._scintillaMainHandle, SCI_INDICSETFLAGS, kReservationIndicator, kIndicatorFlagValueFore);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_INDICSETFLAGS, kReservationIndicator, kIndicatorFlagValueFore);
    SetIndicatorStyle(g_nppData._scintillaMainHandle, kPresenceIndicator, INDIC_FULLBOX, RGB(255, 145, 55), 45);
    SetIndicatorStyle(g_nppData._scintillaSecondHandle, kPresenceIndicator, INDIC_FULLBOX, RGB(255, 145, 55), 45);
    SendMessage(g_nppData._scintillaMainHandle, SCI_INDICSETUNDER, kPresenceIndicator, TRUE);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_INDICSETUNDER, kPresenceIndicator, TRUE);
    SetIndicatorStyle(g_nppData._scintillaMainHandle, kCommentIndicator, INDIC_ROUNDBOX, RGB(235, 175, 35), 55);
    SetIndicatorStyle(g_nppData._scintillaSecondHandle, kCommentIndicator, INDIC_ROUNDBOX, RGB(235, 175, 35), 55);
    SendMessage(g_nppData._scintillaMainHandle, SCI_INDICSETFLAGS, kCommentIndicator, kIndicatorFlagValueFore);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_INDICSETFLAGS, kCommentIndicator, kIndicatorFlagValueFore);
    SetIndicatorStyle(g_nppData._scintillaMainHandle, kSuggestionIndicator, INDIC_STRIKE, RGB(50, 175, 100), 255);
    SetIndicatorStyle(g_nppData._scintillaSecondHandle, kSuggestionIndicator, INDIC_STRIKE, RGB(50, 175, 100), 255);
    SendMessage(g_nppData._scintillaMainHandle, SCI_INDICSETFLAGS, kSuggestionIndicator, kIndicatorFlagValueFore);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_INDICSETFLAGS, kSuggestionIndicator, kIndicatorFlagValueFore);
    SendMessage(g_nppData._scintillaMainHandle, SCI_ANNOTATIONSETVISIBLE, ANNOTATION_HIDDEN, 0);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_ANNOTATIONSETVISIBLE, ANNOTATION_HIDDEN, 0);
    SendMessage(g_nppData._scintillaMainHandle, SCI_EOLANNOTATIONSETVISIBLE, EOLANNOTATION_HIDDEN, 0);
    SendMessage(g_nppData._scintillaSecondHandle, SCI_EOLANNOTATIONSETVISIBLE, EOLANNOTATION_HIDDEN, 0);
    }
    g_writerThread = CreateThread(nullptr, 0, WriterThreadProcedure, nullptr, 0, nullptr);
    g_pipeThread = CreateThread(nullptr, 0, PipeThreadProcedure, nullptr, 0, nullptr);
}

void StopTransport() {
    if (!g_started.exchange(false)) return;
    KillTimer(g_nppData._nppHandle, kObserverTimerId);
    if (g_stopEvent) SetEvent(g_stopEvent);
    if (g_writeEvent) SetEvent(g_writeEvent);
    if (g_lockInitialised.load()) {
        EnterCriticalSection(&g_pipeLock);
        if (g_pipe != INVALID_HANDLE_VALUE) {
            CancelIoEx(g_pipe, nullptr);
        }
        LeaveCriticalSection(&g_pipeLock);
    }
    if (g_pipeThread) {
        WaitForSingleObject(g_pipeThread, 2000);
        CloseHandle(g_pipeThread);
        g_pipeThread = nullptr;
    }
    if (g_writerThread) {
        CancelSynchronousIo(g_writerThread);
        WaitForSingleObject(g_writerThread, 2000);
        CloseHandle(g_writerThread);
        g_writerThread = nullptr;
    }
    RemoveWindowSubclass(g_nppData._nppHandle, MainSubclassProcedure, kMainSubclassId);
    RemoveWindowSubclass(g_nppData._scintillaMainHandle, ScintillaSubclassProcedure, kScintillaSubclassId);
    RemoveWindowSubclass(g_nppData._scintillaSecondHandle, ScintillaSubclassProcedure, kScintillaSubclassId);
    if (g_stopEvent) {
        CloseHandle(g_stopEvent);
        g_stopEvent = nullptr;
    }
    if (g_writeEvent) {
        CloseHandle(g_writeEvent);
        g_writeEvent = nullptr;
    }
    if (g_outboundLockInitialised.load()) {
        EnterCriticalSection(&g_outboundLock);
        g_outbound.clear();
        LeaveCriticalSection(&g_outboundLock);
    }
    if (g_outboundLockInitialised.exchange(false)) DeleteCriticalSection(&g_outboundLock);
    if (g_lockInitialised.exchange(false)) DeleteCriticalSection(&g_pipeLock);
}

void ClearIntegrationState() {
    g_lifecycle.Disconnect();
    g_ipcAuthenticated.store(false);
    g_currentDocumentPath.clear();
    g_activePresencePath.clear();
    g_observedPath.clear();
    g_observedText.clear();
    g_saveDueAt = 0;
    g_presences.clear();
    g_presenceOverlayHits.clear();
    g_hoveredPresenceIds.clear();
    g_reservations.clear();
    g_reservationTargets.clear();
    g_hoveredReservationIds.clear();
    g_externalConflicts.clear();
    g_comments.clear();
    g_suggestions.clear();
    g_commentMessages.clear();
    g_suggestionMessages.clear();
    for (HWND scintilla : {g_nppData._scintillaMainHandle, g_nppData._scintillaSecondHandle}) {
        if (!scintilla) continue;
        const LRESULT length = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
        for (int indicator : {kReservationIndicator, kPresenceIndicator, kCommentIndicator, kSuggestionIndicator}) {
            SendMessage(scintilla, SCI_SETINDICATORCURRENT, indicator, 0);
            SendMessage(scintilla, SCI_INDICATORCLEARRANGE, 0, length);
        }
        SendMessage(scintilla, SCI_ANNOTATIONCLEARALL, 0, 0);
        SendMessage(scintilla, SCI_EOLANNOTATIONCLEARALL, 0, 0);
        InvalidateRect(scintilla, nullptr, TRUE);
    }
    if (g_panel) {
        SendMessageW(g_nppData._nppHandle, NPPM_DMMHIDE, 0, reinterpret_cast<LPARAM>(g_panel));
    }
}

void SetIntegrationEnabled(bool enabled, bool persist) {
    if (g_integrationEnabled == enabled && (!enabled || g_started.load())) {
        if (persist) eaw::plugin::LegacyIntegrationSettings::Save(g_nppData._nppHandle, enabled);
        UpdateIntegrationMenuCheck();
        return;
    }
    g_integrationEnabled = enabled;
    if (persist) eaw::plugin::LegacyIntegrationSettings::Save(g_nppData._nppHandle, enabled);
    UpdateIntegrationMenuCheck();
    if (!g_notepadReady) return;
    if (enabled) {
        if (g_started.load()) StopTransport();
        StartTransport();
        EnsurePanel(true);
        SendMessageW(
            g_nppData._nppHandle,
            NPPM_ADDSCNMODIFIEDFLAGS,
            0,
            SC_MOD_INSERTTEXT | SC_MOD_DELETETEXT | SC_PERFORMED_UNDO | SC_PERFORMED_REDO);
        SendCurrentDocument();
        return;
    }
    StopTransport();
    ClearIntegrationState();
}

void ToggleIntegration() {
    SetIntegrationEnabled(!g_integrationEnabled, true);
}

std::string CurrentDocumentText() {
    const HWND scintilla = CurrentScintilla();
    if (!scintilla) return {};
    const LRESULT length = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    std::string text(static_cast<size_t>(length) + 1, '\0');
    SendMessage(scintilla, SCI_GETTEXT, static_cast<WPARAM>(text.size()), reinterpret_cast<LPARAM>(text.data()));
    text.resize(static_cast<size_t>(length));
    return text;
}

void SendCurrentDocument() {
    const std::wstring pathValue = CurrentPathWide();
    const std::string pathUtf8 = WideToUtf8(pathValue), normalisedPath = NormalisePath(pathUtf8);
    if (normalisedPath != g_currentDocumentPath) {
        if (!g_activePresencePath.empty()
            && NormalisePath(g_activePresencePath) != normalisedPath) {
            WritePipeLine(
                "{\"type\":\"deactivate\",\"path\":\"" + JsonEscape(g_activePresencePath) + "\"}");
            g_activePresencePath.clear();
            g_lastPresenceSentAt = 0;
        }
        g_currentDocumentPath = normalisedPath;
        g_lifecycle.DocumentClosed();
        g_presences.clear();
        g_presenceOverlayHits.clear();
        g_hoveredPresenceIds.clear();
        g_reservations.clear();
        g_reservationTargets.clear();
        g_hoveredReservationIds.clear();
        g_reservationHoverLabelVisible = false;
        g_externalConflicts.clear();
        g_comments.clear();
        g_suggestions.clear();
        g_commentMessages.clear();
        g_suggestionMessages.clear();
        ClearIndicator(kCommentIndicator);
        ClearIndicator(kPresenceIndicator);
        ClearIndicator(kSuggestionIndicator);
        SendMessage(CurrentScintilla(), SCI_ANNOTATIONCLEARALL, 0, 0);
        SendMessage(CurrentScintilla(), SCI_EOLANNOTATIONCLEARALL, 0, 0);
        g_saveDueAt = 0;
        g_lastNotice.clear();
        InvalidatePresenceOverlays();
    }
    UpdatePanel();
    if (!IsTrackedPath(pathValue)) return;
    const std::string text = CurrentDocumentText();
    g_observedPath = normalisedPath;
    g_observedText = text;
    WritePipeLine(
        "{\"type\":\"open\",\"path\":\"" + JsonEscape(pathUtf8) +
        "\",\"textBase64\":\"" + Base64Encode(text.data(), text.size()) + "\"}");
    const HWND scintilla = CurrentScintilla();
    const LRESULT caret = SendMessage(scintilla, SCI_GETCURRENTPOS, 0, 0);
    const LRESULT anchor = SendMessage(scintilla, SCI_GETANCHOR, 0, 0);
    WritePipeLine(
        "{\"type\":\"activate\",\"path\":\"" + JsonEscape(pathUtf8) +
        "\",\"positionByte\":" + std::to_string(caret) +
        ",\"anchorByte\":" + std::to_string(anchor) + "}");
    g_activePresencePath = pathUtf8;
    g_lastCursorPath = pathUtf8;
    g_lastCursorPosition = caret;
    g_lastCursorAnchor = anchor;
    g_lastPresenceSentAt = GetTickCount64();
}
void CloseDocument(UINT_PTR bufferId) {
    std::string pathUtf8; const std::wstring pathValue = PathFromBufferId(bufferId);
    if (IsTrackedPath(pathValue)) pathUtf8 = WideToUtf8(pathValue);
    else {
        const UINT_PTR currentBuffer = static_cast<UINT_PTR>(SendMessageW(g_nppData._nppHandle, NPPM_GETCURRENTBUFFERID, 0, 0));
        if (currentBuffer != bufferId || g_activePresencePath.empty()) return;
        pathUtf8 = g_activePresencePath;
    }
    WritePipeLine("{\"type\":\"close\",\"path\":\"" + JsonEscape(pathUtf8) + "\"}");
    const std::string normalisedPath = NormalisePath(pathUtf8);
    if (normalisedPath == g_currentDocumentPath) {
        g_currentDocumentPath.clear(); g_observedPath.clear(); g_observedText.clear();
        g_lifecycle.DocumentClosed(); g_saveDueAt = 0; UpdatePanel();
    }
    if (normalisedPath == NormalisePath(g_activePresencePath)) {
        g_activePresencePath.clear(); g_lastPresenceSentAt = 0; }
}
void PollCurrentDocument() {
    if (!g_lifecycle.Connected() || g_applyingRemote.load()) return;
    if (!g_activePresencePath.empty()
        && GetTickCount64() - g_lastPresenceSentAt >= kPresenceHeartbeatMilliseconds) {
        SendCursor(true);
    }
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    const std::string pathUtf8 = WideToUtf8(pathValue);
    const std::string normalisedPath = NormalisePath(pathUtf8);
    if (normalisedPath != g_currentDocumentPath) {
        SendCurrentDocument();
        return;
    }
    if (!g_lifecycle.Ready() || normalisedPath != g_observedPath) return;
    const std::string text = CurrentDocumentText();
    if (text == g_observedText) return;
    g_observedText = text;
    WritePipeLine(
        "{\"type\":\"snapshot\",\"path\":\"" + JsonEscape(pathUtf8) +
        "\",\"textBase64\":\"" + Base64Encode(text.data(), text.size()) + "\"}");
    ScheduleAutoSave();
}

void ScheduleAutoSave(bool immediate) {
    if (
        g_lifecycle.BranchBlocked()
        || !g_externalConflicts.empty()
        || !g_lifecycle.Connected()
        || !g_lifecycle.Ready()
        || !IsTrackedPath(CurrentPathWide())) {
        return;
    }
    g_savePath = NormalisePath(WideToUtf8(CurrentPathWide()));
    g_saveDueAt = GetTickCount64() + (immediate ? 100 : 1000);
}

void MaybeAutoSave() {
    if (!g_saveDueAt || GetTickCount64() < g_saveDueAt) return;
    if (
        g_lifecycle.BranchBlocked()
        || !g_externalConflicts.empty()
        || !g_lifecycle.Ready()
        || NormalisePath(WideToUtf8(CurrentPathWide())) != g_savePath) {
        g_saveDueAt = 0;
        return;
    }
    g_saveDueAt = 0;
    SendMessageW(g_nppData._nppHandle, NPPM_SAVECURRENTFILE, 0, 0);
}

void SendEdit(const SCNotification* notification) {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    const std::string pathUtf8 = WideToUtf8(pathValue);
    const std::string normalisedPath = NormalisePath(pathUtf8);
    if (!g_lifecycle.Ready() || normalisedPath != g_currentDocumentPath
        || normalisedPath != g_observedPath) return;
    const bool inserted = (notification->modificationType & SC_MOD_INSERTTEXT) != 0;
    const bool deleted = (notification->modificationType & SC_MOD_DELETETEXT) != 0;
    if (!inserted && !deleted) return;
    const size_t insertedLength = inserted && notification->text
        ? static_cast<size_t>(notification->length)
        : 0;
    WritePipeLine(
        "{\"type\":\"edit\",\"path\":\"" + JsonEscape(pathUtf8) +
        "\",\"positionByte\":" + std::to_string(notification->position) +
        ",\"deleteBytes\":" + std::to_string(deleted ? notification->length : 0) +
        ",\"insertBase64\":\"" + Base64Encode(notification->text, insertedLength) + "\"}");
    ScheduleAutoSave();
}

void SendCursor(bool force) {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    const HWND scintilla = CurrentScintilla();
    const std::string pathUtf8 = WideToUtf8(pathValue);
    if (NormalisePath(pathUtf8) != NormalisePath(g_activePresencePath)) return;
    const LRESULT caret = SendMessage(scintilla, SCI_GETCURRENTPOS, 0, 0);
    const LRESULT anchor = SendMessage(scintilla, SCI_GETANCHOR, 0, 0);
    if (!force && pathUtf8 == g_lastCursorPath && caret == g_lastCursorPosition && anchor == g_lastCursorAnchor) return;
    g_lastCursorPath = pathUtf8;
    g_lastCursorPosition = caret;
    g_lastCursorAnchor = anchor;
    WritePipeLine(
        "{\"type\":\"cursor\",\"path\":\"" + JsonEscape(pathUtf8) +
        "\",\"positionByte\":" + std::to_string(caret) +
        ",\"anchorByte\":" + std::to_string(anchor) + "}");
    g_lastPresenceSentAt = GetTickCount64();
}

void ReserveSelection() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) {
        MessageBoxW(g_nppData._nppHandle, L"Откройте поддерживаемый localisation *.yml", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    const HWND scintilla = CurrentScintilla();
    const LRESULT start = SendMessage(scintilla, SCI_GETSELECTIONSTART, 0, 0);
    const LRESULT end = SendMessage(scintilla, SCI_GETSELECTIONEND, 0, 0);
    ReservationTargetEntry target{g_agentUserId, g_agentUser, g_agentColor};
    if (g_reservationTargetCombo) {
        const LRESULT selected = SendMessageW(g_reservationTargetCombo, CB_GETCURSEL, 0, 0);
        if (selected != CB_ERR && static_cast<size_t>(selected) < g_reservationTargets.size()) {
            target = g_reservationTargets[static_cast<size_t>(selected)];
        }
    }
    WritePipeLine(
        "{\"type\":\"reservationCreate\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue)) +
        "\",\"startByte\":" + std::to_string(start) +
        ",\"endByte\":" + std::to_string(end) +
        ",\"assigneeId\":\"" + JsonEscape(target.id) +
        "\",\"assignee\":\"" + JsonEscape(target.displayName) +
        "\",\"assigneeColor\":\"" + JsonEscape(target.color) + "\"}");
}

void CreateComment() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue) || !g_lifecycle.Ready()) {
        MessageBoxW(g_nppData._nppHandle, L"Откройте подключённый localisation *.yml.", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    std::wstring body;
    if (!PromptText(L"Новый комментарий", L"Комментарий к выделению или позиции курсора (до 2 КиБ)", body, 1024, false)) return;
    const HWND scintilla = CurrentScintilla();
    const LRESULT start = SendMessage(scintilla, SCI_GETSELECTIONSTART, 0, 0);
    const LRESULT end = SendMessage(scintilla, SCI_GETSELECTIONEND, 0, 0);
    const std::string bodyUtf8 = WideToUtf8(body);
    WritePipeLine("{\"type\":\"commentCreate\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue))
        + "\",\"startByte\":" + std::to_string(start) + ",\"endByte\":" + std::to_string(end)
        + ",\"bodyBase64\":\"" + Base64Encode(bodyUtf8.data(), bodyUtf8.size()) + "\"}");
}

void CreateSuggestion() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue) || !g_lifecycle.Ready()) {
        MessageBoxW(g_nppData._nppHandle, L"Откройте подключённый localisation *.yml.", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    const HWND scintilla = CurrentScintilla();
    const LRESULT start = SendMessage(scintilla, SCI_GETSELECTIONSTART, 0, 0);
    const LRESULT end = SendMessage(scintilla, SCI_GETSELECTIONEND, 0, 0);
    if (start == end) {
        MessageBoxW(g_nppData._nppHandle, L"Сначала выделите текст, который хотите заменить.", kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    const LRESULT length = SendMessage(scintilla, SCI_GETSELTEXT, 0, 0);
    std::string selected(static_cast<size_t>(std::max<LRESULT>(length, 1)), '\0');
    SendMessage(scintilla, SCI_GETSELTEXT, 0, reinterpret_cast<LPARAM>(selected.data()));
    if (!selected.empty() && selected.back() == '\0') selected.pop_back();
    std::wstring replacement = Utf8ToWide(selected);
    if (!PromptText(L"Предложить правку", L"Новый текст (пустой удалит выделение, лимит 16 КиБ)", replacement, 4096, true)) return;
    const std::string replacementUtf8 = WideToUtf8(replacement);
    WritePipeLine("{\"type\":\"suggestionCreate\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue))
        + "\",\"startByte\":" + std::to_string(start) + ",\"endByte\":" + std::to_string(end)
        + ",\"replacementBase64\":\"" + Base64Encode(replacementUtf8.data(), replacementUtf8.size()) + "\"}");
}

void DeleteReservationAtCaret() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    const LRESULT caret = SendMessage(CurrentScintilla(), SCI_GETCURRENTPOS, 0, 0);
    WritePipeLine(
        "{\"type\":\"reservationDeleteAt\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue)) +
        "\",\"positionByte\":" + std::to_string(caret) + "}");
}

void CollaborativeUndo() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    WritePipeLine("{\"type\":\"undo\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue)) + "\"}");
}

void CollaborativeRedo() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) return;
    WritePipeLine("{\"type\":\"redo\",\"path\":\"" + JsonEscape(WideToUtf8(pathValue)) + "\"}");
}

void ShowCollaborationPanel() {
    if (!g_integrationEnabled) {
        MessageBoxW(g_nppData._nppHandle,
            L"Интеграция Legacy-плагина выключена. Включите её первой командой меню плагина.",
            kPluginName, MB_OK | MB_ICONINFORMATION);
        return;
    }
    EnsurePanel(true);
}
void OpenReviewApplication() {
    const std::wstring pathValue = CurrentPathWide();
    if (!IsTrackedPath(pathValue)) {
        MessageBoxW(g_nppData._nppHandle,
            L"Текущий файл не входит в localisation/russian, localisation/english или localisation/replace этого репозитория.",
            kPluginName, MB_OK | MB_ICONWARNING);
        return;
    }
    const std::string pathUtf8 = WideToUtf8(pathValue);
    if (g_lifecycle.Connected())
        WritePipeLine("{\"type\":\"reviewOpen\",\"path\":\"" + JsonEscape(pathUtf8) + "\"}");
    else {
        g_pendingReviewPath = pathUtf8; StartTransport(true);
    }
}
void ShowConnectionStatus() {
    const bool tracked = IsTrackedPath(CurrentPathWide());
    std::wstring message = g_lifecycle.Connected()
        ? L"Подключение к Desktop Agent установлено."
        : L"Нет подключения к Desktop Agent.";
    if (!g_agentUser.empty()) message += L"\nПользователь: " + Utf8ToWide(g_agentUser);
    if (!g_workspace.empty()) message += L"\nWorkspace: " + Utf8ToWide(g_workspace);
    message += L"\nСостояние документа: " + Utf8ToWide(g_lifecycle.Status());
    if (!g_documentStatusMessage.empty()) message += L"\n" + Utf8ToWide(g_documentStatusMessage);
    message += tracked
        ? L"\nТекущий файл участвует в синхронизации."
        : L"\nТекущий файл не входит в поддерживаемые папки localisation.";
    MessageBoxW(
        g_nppData._nppHandle,
        message.c_str(),
        kPluginName,
        MB_OK | (g_lifecycle.Connected() && tracked ? MB_ICONINFORMATION : MB_ICONWARNING));
}
void ConfigureMenu() {
    wcscpy_s(g_functions[0]._itemName, L"Включить интеграцию с Agent"); g_functions[0]._pFunc = ToggleIntegration;
    wcscpy_s(g_functions[1]._itemName, L"Открыть Legacy-панель совместной работы"); g_functions[1]._pFunc = ShowCollaborationPanel;
    wcscpy_s(g_functions[2]._itemName, L"Забронировать выделение"); g_functions[2]._pFunc = ReserveSelection;
    g_functions[2]._pShKey = &g_reserveShortcut;
    wcscpy_s(g_functions[3]._itemName, L"Удалить бронь под курсором"); g_functions[3]._pFunc = DeleteReservationAtCaret;
    wcscpy_s(g_functions[4]._itemName, L"Совместная отмена"); g_functions[4]._pFunc = CollaborativeUndo;
    g_functions[4]._pShKey = &g_undoShortcut;
    wcscpy_s(g_functions[5]._itemName, L"Совместный повтор"); g_functions[5]._pFunc = CollaborativeRedo;
    g_functions[5]._pShKey = &g_redoShortcut;
    wcscpy_s(g_functions[6]._itemName, L"Показать статус подключения"); g_functions[6]._pFunc = ShowConnectionStatus;
    wcscpy_s(g_functions[7]._itemName, L"Оставить комментарий"); g_functions[7]._pFunc = CreateComment;
    wcscpy_s(g_functions[8]._itemName, L"Предложить правку"); g_functions[8]._pFunc = CreateSuggestion;
    wcscpy_s(g_functions[9]._itemName, L"Открыть текущий файл в Review"); g_functions[9]._pFunc = OpenReviewApplication;
}
} // namespace
BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { g_instance = module; DisableThreadLibraryCalls(module); }
    return TRUE;
}
extern "C" __declspec(dllexport) void setInfo(NppData data) {
    g_nppData = data; ConfigureMenu();
}
extern "C" __declspec(dllexport) const wchar_t* getName() { return kPluginName; }
extern "C" __declspec(dllexport) FuncItem* getFuncsArray(int* count) {
    *count = static_cast<int>(std::size(g_functions)); return g_functions;
}
extern "C" __declspec(dllexport) void beNotified(SCNotification* notification) {
    if (!notification) return;
    if (notification->nmhdr.code == NPPN_READY) {
        g_notepadReady = true;
        g_integrationEnabled = eaw::plugin::LegacyIntegrationSettings::Load(g_nppData._nppHandle);
        UpdateIntegrationMenuCheck();
        if (g_integrationEnabled) SetIntegrationEnabled(true, false);
        return;
    }
    if (notification->nmhdr.code == NPPN_SHUTDOWN) {
        g_notepadReady = false; StopTransport(); return;
    }
    if (!g_integrationEnabled) return;
    if (notification->nmhdr.code == NPPN_BUFFERACTIVATED || notification->nmhdr.code == NPPN_FILEOPENED) {
        SendCurrentDocument(); return;
    }
    if (notification->nmhdr.code == NPPN_FILEBEFORECLOSE) {
        CloseDocument(static_cast<UINT_PTR>(notification->nmhdr.idFrom)); return;
    }
    if (notification->nmhdr.code == NPPN_FILESAVED) { g_saveDueAt = 0; return; }
    if (g_applyingRemote.load()) return;
    if (notification->nmhdr.code == SCN_MODIFIED) SendEdit(notification);
    else if (notification->nmhdr.code == SCN_UPDATEUI) {
        SendCursor(false); SyncReviewPanelToViewport(); InvalidatePresenceOverlays();
    }
}
extern "C" __declspec(dllexport) LRESULT messageProc(UINT, WPARAM, LPARAM) { return TRUE; }
extern "C" __declspec(dllexport) BOOL isUnicode() { return TRUE; }
