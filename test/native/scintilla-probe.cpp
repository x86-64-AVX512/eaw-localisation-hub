#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <charconv>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr UINT SCI_ADDTEXT = 2001;
constexpr UINT SCI_REDO = 2011;
constexpr UINT SCI_CANREDO = 2016;
constexpr UINT SCI_GETLENGTH = 2006;
constexpr UINT SCI_GETCURRENTPOS = 2008;
constexpr UINT SCI_GETTEXT = 2182;
constexpr UINT SCI_SETSEL = 2160;
constexpr UINT SCI_INDICATORVALUEAT = 2507;
constexpr UINT SCI_LINEFROMPOSITION = 2166;
constexpr UINT SCI_ANNOTATIONGETLINES = 2546;
constexpr UINT SCI_CANUNDO = 2174;
constexpr UINT SCI_UNDO = 2176;
constexpr UINT NPPMSG = WM_USER + 1000;
constexpr UINT NPPM_SWITCHTOFILE = NPPMSG + 37;
constexpr UINT NPPM_DOOPEN = NPPMSG + 77;
constexpr int RESERVATION_INDICATOR = 20;
constexpr int PRESENCE_INDICATOR = 21;
constexpr int SUGGESTION_INDICATOR = 23;

struct SearchContext {
    DWORD processId{};
    DWORD threadId{};
    HWND topLevel{};
    HWND scintilla{};
    long long area{};
};

BOOL CALLBACK FindScintilla(HWND window, LPARAM parameter) {
    auto* context = reinterpret_cast<SearchContext*>(parameter);
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    if (processId != context->processId || !IsWindowVisible(window)) return TRUE;

    wchar_t className[64]{};
    GetClassNameW(window, className, static_cast<int>(std::size(className)));
    if (std::wstring(className) == L"Scintilla") {
        RECT client{};
        GetClientRect(window, &client);
        const long long area = static_cast<long long>(client.right - client.left)
            * static_cast<long long>(client.bottom - client.top);
        if (area > context->area) {
            context->area = area;
            context->scintilla = window;
        }
    }
    return TRUE;
}

HWND FindVisibleScintilla(DWORD processId) {
    SearchContext context{processId};
    const ULONGLONG deadline = GetTickCount64() + 10000;
    while (!context.scintilla && GetTickCount64() < deadline) {
        EnumWindows([](HWND topLevel, LPARAM parameter) -> BOOL {
            auto* inner = reinterpret_cast<SearchContext*>(parameter);
            DWORD processId = 0;
            const DWORD threadId = GetWindowThreadProcessId(topLevel, &processId);
            if (processId == inner->processId) {
                if (IsWindowVisible(topLevel)) {
                    inner->threadId = threadId;
                    inner->topLevel = topLevel;
                }
                EnumChildWindows(topLevel, FindScintilla, parameter);
            }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&context));
        if (context.threadId) {
            GUITHREADINFO gui{sizeof(GUITHREADINFO)};
            if (GetGUIThreadInfo(context.threadId, &gui) && gui.hwndFocus) {
                wchar_t className[64]{};
                GetClassNameW(gui.hwndFocus, className, static_cast<int>(std::size(className)));
                if (std::wstring(className) == L"Scintilla") return gui.hwndFocus;
            }
        }
        if (!context.scintilla) Sleep(100);
    }
    return context.scintilla;
}

UINT FindMenuCommand(HMENU menu, const std::wstring& target) {
    const int count = GetMenuItemCount(menu);
    for (int index = 0; index < count; ++index) {
        wchar_t label[512]{};
        GetMenuStringW(menu, index, label, static_cast<int>(std::size(label)), MF_BYPOSITION);
        const HMENU submenu = GetSubMenu(menu, index);
        if (submenu) {
            const UINT nested = FindMenuCommand(submenu, target);
            if (nested != 0) return nested;
        } else if (std::wstring(label).find(target) != std::wstring::npos) {
            const UINT command = GetMenuItemID(menu, index);
            if (command != static_cast<UINT>(-1)) return command;
        }
    }
    return 0;
}

bool InvokePluginCommand(HWND topLevel, const std::wstring& label) {
    const UINT command = FindMenuCommand(GetMenu(topLevel), label);
    if (!command) return false;
    SendMessageW(topLevel, WM_COMMAND, MAKEWPARAM(command, 0), 0);
    return true;
}

struct PanelControls {
    DWORD processId{};
    HWND status{};
    HWND participants{};
    HWND reservations{};
    HWND conflicts{};
    HWND keepCollaborative{};
    HWND useExternal{};
    HWND reservationTarget{};
    HWND comments{};
    HWND suggestions{};
    HWND suggestionAccept{};
    HWND suggestionDisplay{};
};

std::string ReadText(HANDLE process, HWND scintilla);
bool ParseColour(const std::string& value, BYTE& red, BYTE& green, BYTE& blue);

BOOL CALLBACK FindPanelControl(HWND window, LPARAM parameter) {
    auto* controls = reinterpret_cast<PanelControls*>(parameter);
    switch (GetDlgCtrlID(window)) {
        case 1101: controls->status = window; break;
        case 1105: controls->participants = window; break;
        case 1107: controls->reservations = window; break;
        case 1111: controls->conflicts = window; break;
        case 1112: controls->keepCollaborative = window; break;
        case 1113: controls->useExternal = window; break;
        case 1115: controls->reservationTarget = window; break;
        case 1117: controls->comments = window; break;
        case 1122: controls->suggestions = window; break;
        case 1124: controls->suggestionAccept = window; break;
        case 1128: controls->suggestionDisplay = window; break;
        default: break;
    }
    return TRUE;
}

PanelControls FindPanelControls(DWORD processId) {
    PanelControls controls{processId};
    EnumWindows([](HWND topLevel, LPARAM parameter) -> BOOL {
        auto* inner = reinterpret_cast<PanelControls*>(parameter);
        DWORD processId = 0;
        GetWindowThreadProcessId(topLevel, &processId);
        if (processId == inner->processId) EnumChildWindows(topLevel, FindPanelControl, parameter);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&controls));
    return controls;
}

bool PanelIsReady(DWORD processId) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.status || !controls.participants || !controls.reservations
        || !controls.suggestionDisplay
        || SendMessageW(controls.suggestionDisplay, CB_GETCOUNT, 0, 0) != 3
        || SendMessageW(controls.suggestionDisplay, CB_GETCURSEL, 0, 0) != 0) return false;
    wchar_t status[512]{};
    GetWindowTextW(controls.status, status, static_cast<int>(std::size(status)));
    return std::wstring(status).find(L"Подключено") != std::wstring::npos
        && SendMessageW(controls.participants, LB_GETCOUNT, 0, 0) >= 1;
}

bool ReservationCountMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    return controls.reservations
        && SendMessageW(controls.reservations, LB_GETCOUNT, 0, 0) == expected;
}

bool ParticipantCountMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    return controls.participants
        && SendMessageW(controls.participants, LB_GETCOUNT, 0, 0) == expected;
}

bool ConflictCountMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    return controls.conflicts
        && SendMessageW(controls.conflicts, LB_GETCOUNT, 0, 0) == expected;
}

bool SuggestionCountMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    return controls.suggestions && SendMessageW(controls.suggestions, LB_GETCOUNT, 0, 0) == expected;
}

bool CommentCardMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.comments || SendMessageW(controls.comments, LB_GETCOUNT, 0, 0) != expected) return false;
    const LONG_PTR style = GetWindowLongPtrW(controls.comments, GWL_STYLE);
    return (style & LBS_OWNERDRAWVARIABLE) != 0 && SendMessageW(controls.comments, LB_GETITEMHEIGHT, 0, 0) >= 40;
}

bool AcceptFirstSuggestion(DWORD processId) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.suggestions || !controls.suggestionAccept
        || SendMessageW(controls.suggestions, LB_GETCOUNT, 0, 0) < 1) return false;
    SendMessageW(controls.suggestions, LB_SETCURSEL, 0, 0);
    SendMessageW(GetParent(controls.suggestions), WM_COMMAND,
        MAKEWPARAM(1122, LBN_SELCHANGE), reinterpret_cast<LPARAM>(controls.suggestions));
    SendMessageW(controls.suggestionAccept, BM_CLICK, 0, 0);
    return true;
}

bool SetSuggestionMode(DWORD processId, LRESULT mode) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.suggestionDisplay || mode < 0 || mode > 2) return false;
    if (SendMessageW(controls.suggestionDisplay, CB_SETCURSEL, mode, 0) == CB_ERR) return false;
    SendMessageW(GetParent(controls.suggestionDisplay), WM_COMMAND,
        MAKEWPARAM(1128, CBN_SELCHANGE), reinterpret_cast<LPARAM>(controls.suggestionDisplay));
    return SendMessageW(controls.suggestionDisplay, CB_GETCURSEL, 0, 0) == mode;
}

bool SuggestionVisualHidden(HANDLE process, HWND scintilla) {
    const std::string text = ReadText(process, scintilla);
    const size_t position = text.find("\"One\"");
    if (position == std::string::npos) return false;
    const UINT ghostMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestSuggestionGhostVisible.0.6.5");
    return SendMessageW(scintilla, SCI_INDICATORVALUEAT, SUGGESTION_INDICATOR, position) == 0
        && ghostMessage
        && SendMessageW(scintilla, ghostMessage, 0, 0) == 0;
}

bool SuggestionVisualMatches(HANDLE process, HWND scintilla, const std::string& value) {
    BYTE red = 0;
    BYTE green = 0;
    BYTE blue = 0;
    if (!ParseColour(value, red, green, blue)) return false;
    const std::string text = ReadText(process, scintilla);
    const size_t position = text.find("\"One\"");
    if (position == std::string::npos) return false;
    const COLORREF expected = RGB(red, green, blue);
    const LRESULT actual = SendMessageW(scintilla, SCI_INDICATORVALUEAT, SUGGESTION_INDICATOR, position);
    const LRESULT line = SendMessageW(scintilla, SCI_LINEFROMPOSITION, position, 0);
    const UINT ghostMessage = RegisterWindowMessageW(L"EaWLocalisationHub.TestSuggestionGhostVisible.0.6.5");
    return (actual & 0xFFFFFF) == (expected & 0xFFFFFF)
        && SendMessageW(scintilla, SCI_ANNOTATIONGETLINES, line, 0) == 0
        && ghostMessage
        && SendMessageW(scintilla, ghostMessage, 0, 0) == 1;
}

bool ResolveFirstConflict(DWORD processId, bool external) {
    const PanelControls controls = FindPanelControls(processId);
    const HWND button = external ? controls.useExternal : controls.keepCollaborative;
    if (!controls.conflicts || !button || SendMessageW(controls.conflicts, LB_GETCOUNT, 0, 0) < 1) return false;
    SendMessageW(controls.conflicts, LB_SETCURSEL, 0, 0);
    SendMessageW(button, BM_CLICK, 0, 0);
    return true;
}

bool JumpToParticipant(DWORD processId, LRESULT index) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.participants
        || index < 0
        || index >= SendMessageW(controls.participants, LB_GETCOUNT, 0, 0)) {
        return false;
    }
    SendMessageW(controls.participants, LB_SETCURSEL, index, 0);
    SendMessageW(
        GetParent(controls.participants),
        WM_COMMAND,
        MAKEWPARAM(1105, LBN_SELCHANGE),
        reinterpret_cast<LPARAM>(controls.participants));
    return true;
}

bool ReservationTargetCountMatches(DWORD processId, LRESULT expected) {
    const PanelControls controls = FindPanelControls(processId);
    return controls.reservationTarget
        && SendMessageW(controls.reservationTarget, CB_GETCOUNT, 0, 0) == expected;
}

bool SelectReservationTarget(DWORD processId, LRESULT index) {
    const PanelControls controls = FindPanelControls(processId);
    if (!controls.reservationTarget
        || index < 0
        || index >= SendMessageW(controls.reservationTarget, CB_GETCOUNT, 0, 0)) return false;
    return SendMessageW(controls.reservationTarget, CB_SETCURSEL, index, 0) != CB_ERR;
}

HANDLE OpenTarget(DWORD processId) {
    return OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
        FALSE,
        processId);
}

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) return {};
    std::wstring result(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length);
    return result;
}

bool SendPathMessage(HANDLE process, HWND notepad, UINT message, const std::string& path) {
    const std::wstring wide = Utf8ToWide(path);
    if (wide.empty()) return false;
    const SIZE_T bytes = (wide.size() + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return false;
    SIZE_T written = 0;
    const bool copied = WriteProcessMemory(process, remote, wide.c_str(), bytes, &written) && written == bytes;
    const bool accepted = copied && SendMessageW(notepad, message, 0, reinterpret_cast<LPARAM>(remote)) != FALSE;
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    return accepted;
}

bool AddText(HANDLE process, HWND scintilla, const std::string& text) {
    void* remote = VirtualAllocEx(process, nullptr, text.size(), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return false;
    SIZE_T written = 0;
    const bool copied = WriteProcessMemory(process, remote, text.data(), text.size(), &written) && written == text.size();
    if (copied) SendMessageW(scintilla, SCI_ADDTEXT, text.size(), reinterpret_cast<LPARAM>(remote));
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    return copied;
}

std::string ReadText(HANDLE process, HWND scintilla) {
    const LRESULT length = SendMessageW(scintilla, SCI_GETLENGTH, 0, 0);
    if (length < 0 || length > 16 * 1024 * 1024) return {};
    const SIZE_T capacity = static_cast<SIZE_T>(length) + 1;
    void* remote = VirtualAllocEx(process, nullptr, capacity, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return {};
    SendMessageW(scintilla, SCI_GETTEXT, capacity, reinterpret_cast<LPARAM>(remote));
    std::vector<char> buffer(capacity, '\0');
    SIZE_T read = 0;
    const bool copied = ReadProcessMemory(process, remote, buffer.data(), capacity, &read) != FALSE;
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    if (!copied || read == 0) return {};
    return std::string(buffer.data(), strnlen(buffer.data(), buffer.size()));
}

int HexDigit(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

bool ParseColour(const std::string& value, BYTE& red, BYTE& green, BYTE& blue) {
    if (value.size() != 7 || value[0] != '#') return false;
    int digits[6]{};
    for (size_t index = 0; index < 6; ++index) {
        digits[index] = HexDigit(value[index + 1]);
        if (digits[index] < 0) return false;
    }
    red = static_cast<BYTE>(digits[0] * 16 + digits[1]);
    green = static_cast<BYTE>(digits[2] * 16 + digits[3]);
    blue = static_cast<BYTE>(digits[4] * 16 + digits[5]);
    return true;
}

bool OverlayColourVisible(
    HWND scintilla,
    const std::string& value,
    size_t requiredPixels = 20,
    POINT* firstMatch = nullptr) {
    BYTE expectedRed = 0;
    BYTE expectedGreen = 0;
    BYTE expectedBlue = 0;
    if (!ParseColour(value, expectedRed, expectedGreen, expectedBlue)) return false;

    RedrawWindow(scintilla, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
    RECT client{};
    GetClientRect(scintilla, &client);
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) return false;

    HDC source = GetDC(scintilla);
    HDC target = CreateCompatibleDC(source);
    HBITMAP bitmap = CreateCompatibleBitmap(source, width, height);
    const HGDIOBJ previous = SelectObject(target, bitmap);
    const bool copied = BitBlt(target, 0, 0, width, height, source, 0, 0, SRCCOPY | CAPTUREBLT) != FALSE;

    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    std::vector<BYTE> pixels(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
    const bool read = copied && GetDIBits(
        target,
        bitmap,
        0,
        static_cast<UINT>(height),
        pixels.data(),
        &info,
        DIB_RGB_COLORS) != 0;

    SelectObject(target, previous);
    DeleteObject(bitmap);
    DeleteDC(target);
    ReleaseDC(scintilla, source);
    if (!read) return false;

    size_t matchingPixels = 0;
    for (size_t offset = 0; offset + 3 < pixels.size(); offset += 4) {
        if (pixels[offset] == expectedBlue
            && pixels[offset + 1] == expectedGreen
            && pixels[offset + 2] == expectedRed) {
            if (matchingPixels == 0 && firstMatch) {
                const size_t pixelIndex = offset / 4;
                firstMatch->x = static_cast<LONG>(pixelIndex % static_cast<size_t>(width));
                firstMatch->y = static_cast<LONG>(pixelIndex / static_cast<size_t>(width));
            }
            matchingPixels += 1;
            if (matchingPixels >= requiredPixels) return true;
        }
    }
    return false;
}

bool HoverOverlayColour(HWND scintilla, const std::string& value) {
    POINT point{};
    if (!OverlayColourVisible(scintilla, value, 20, &point)) return false;
    POINT screenPoint = point;
    ClientToScreen(scintilla, &screenPoint);
    SetCursorPos(screenPoint.x, screenPoint.y);
    SendMessageW(scintilla, WM_MOUSEMOVE, 0, MAKELPARAM(point.x, point.y));
    const UINT message = RegisterWindowMessageW(L"EaWLocalisationHub.TestHoverPresence.0.4");
    if (!message || SendMessageW(scintilla, message, 0, 0) != 1) return false;
    RedrawWindow(scintilla, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
    Sleep(100);
    return true;
}

bool ReservationColourMatches(HWND scintilla, const std::string& value) {
    BYTE red = 0;
    BYTE green = 0;
    BYTE blue = 0;
    if (!ParseColour(value, red, green, blue)) return false;
    const COLORREF expected = RGB(red, green, blue);
    const LRESULT actual = SendMessageW(scintilla, SCI_INDICATORVALUEAT, RESERVATION_INDICATOR, 1);
    return (actual & 0xFFFFFF) == (expected & 0xFFFFFF);
}

bool PresenceSelectionMatches(HWND scintilla, const std::string& value) {
    BYTE red = 0;
    BYTE green = 0;
    BYTE blue = 0;
    if (!ParseColour(value, red, green, blue)) return false;
    const COLORREF expected = RGB(red, green, blue);
    const LRESULT actual = SendMessageW(scintilla, SCI_INDICATORVALUEAT, PRESENCE_INDICATOR, 1);
    return (actual & 0xFFFFFF) == (expected & 0xFFFFFF);
}

bool HoverReservation(HWND scintilla) {
    const UINT message = RegisterWindowMessageW(L"EaWLocalisationHub.TestHoverReservation.0.6.5");
    if (!message || SendMessageW(scintilla, message, 0, 0) != 1) return false;
    RedrawWindow(scintilla, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
    Sleep(100);
    return true;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "usage: scintilla-probe <pid> <command> <text>\n";
        return 2;
    }

    DWORD processId = 0;
    const std::string pidText = argv[1];
    const auto parsed = std::from_chars(pidText.data(), pidText.data() + pidText.size(), processId);
    if (parsed.ec != std::errc{} || processId == 0) {
        std::cerr << "invalid pid\n";
        return 2;
    }

    const HWND scintilla = FindVisibleScintilla(processId);
    if (!scintilla) {
        std::cerr << "visible Scintilla window not found\n";
        return 3;
    }
    HANDLE process = OpenTarget(processId);
    if (!process) {
        std::cerr << "OpenProcess failed: " << GetLastError() << "\n";
        return 4;
    }

    const std::string command = argv[2];
    const std::string text = argv[3];
    int result = 0;
    if (command == "add") {
        if (!AddText(process, scintilla, text)) result = 5;
    } else if (command == "undo") {
        if (!SendMessageW(scintilla, SCI_CANUNDO, 0, 0)) result = 38;
        else SendMessageW(scintilla, SCI_UNDO, 0, 0);
    } else if (command == "redo") {
        if (!SendMessageW(scintilla, SCI_CANREDO, 0, 0)) result = 39;
        else SendMessageW(scintilla, SCI_REDO, 0, 0);
    } else if (command == "contains") {
        result = ReadText(process, scintilla).find(text) == std::string::npos ? 6 : 0;
    } else if (command == "dump") {
        std::cout << ReadText(process, scintilla);
    } else if (command == "caret-eof") {
        const LRESULT length = SendMessageW(scintilla, SCI_GETLENGTH, 0, 0);
        SendMessageW(scintilla, SCI_SETSEL, length, length);
    } else if (command == "select-prefix") {
        LRESULT length = 0;
        const auto lengthParsed = std::from_chars(text.data(), text.data() + text.size(), length);
        const LRESULT documentLength = SendMessageW(scintilla, SCI_GETLENGTH, 0, 0);
        if (lengthParsed.ec != std::errc{} || length <= 0 || length > documentLength) result = 33;
        else SendMessageW(scintilla, SCI_SETSEL, 0, length);
    } else if (command == "caret-is-eof") {
        const LRESULT length = SendMessageW(scintilla, SCI_GETLENGTH, 0, 0);
        const LRESULT position = SendMessageW(scintilla, SCI_GETCURRENTPOS, 0, 0);
        if (position != length) result = 19;
    } else if (command == "open-file") {
        if (!SendPathMessage(process, GetAncestor(scintilla, GA_ROOT), NPPM_DOOPEN, text)) result = 25;
    } else if (command == "switch-file") {
        if (!SendPathMessage(process, GetAncestor(scintilla, GA_ROOT), NPPM_SWITCHTOFILE, text)) result = 26;
    } else if (command == "jump-participant") {
        LRESULT index = -1;
        const auto indexParsed = std::from_chars(text.data(), text.data() + text.size(), index);
        if (indexParsed.ec != std::errc{} || !JumpToParticipant(processId, index)) result = 20;
    } else if (command == "mouse-away") {
        RECT root{};
        GetWindowRect(GetAncestor(scintilla, GA_ROOT), &root);
        SetCursorPos(root.right - 8, root.top + 8);
        SendMessageW(scintilla, WM_MOUSELEAVE, 0, 0);
        RedrawWindow(scintilla, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
        Sleep(100);
    } else if (command == "overlay-color") {
        if (!OverlayColourVisible(scintilla, text)) result = 15;
    } else if (command == "overlay-label") {
        const UINT message = RegisterWindowMessageW(L"EaWLocalisationHub.TestPresenceLabelVisible.0.6.5");
        if (!message || SendMessageW(scintilla, message, 0, 0) != 1) result = 17;
    } else if (command == "hover-color") {
        if (!HoverOverlayColour(scintilla, text)) result = 18;
    } else if (command == "reservation-color") {
        if (!ReservationColourMatches(scintilla, text)) result = 21;
    } else if (command == "presence-selection") {
        if (!PresenceSelectionMatches(scintilla, text)) result = 34;
    } else if (command == "hover-reservation") {
        if (!HoverReservation(scintilla)) result = 22;
    } else if (command == "select-reservation-target") {
        LRESULT index = -1;
        const auto indexParsed = std::from_chars(text.data(), text.data() + text.size(), index);
        if (indexParsed.ec != std::errc{} || !SelectReservationTarget(processId, index)) result = 23;
    } else if (command == "reservation-target-count") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !ReservationTargetCountMatches(processId, expected)) result = 24;
    } else if (command == "reserve") {
        const LRESULT length = SendMessageW(scintilla, SCI_GETLENGTH, 0, 0);
        SendMessageW(scintilla, SCI_SETSEL, 0, length);
        if (!InvokePluginCommand(GetAncestor(scintilla, GA_ROOT), L"Забронировать выделение")) result = 7;
    } else if (command == "delete-at") {
        SendMessageW(scintilla, SCI_SETSEL, 1, 1);
        if (!InvokePluginCommand(GetAncestor(scintilla, GA_ROOT), L"Удалить бронь под курсором")) result = 8;
    } else if (command == "panel-ready") {
        if (!PanelIsReady(processId)) result = 9;
    } else if (command == "reservation-count") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !ReservationCountMatches(processId, expected)) result = 10;
    } else if (command == "create-suggestion") {
        const UINT message = RegisterWindowMessageW(L"EaWLocalisationHub.TestCreateSuggestion.0.6.5");
        if (!message || SendMessageW(GetAncestor(scintilla, GA_ROOT), message, 0, 0) != 1) result = 27;
    } else if (command == "suggestion-count") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !SuggestionCountMatches(processId, expected)) result = 28;
    } else if (command == "create-comment") {
        const UINT message = RegisterWindowMessageW(L"EaWLocalisationHub.TestCreateComment.0.6.5");
        if (!message || SendMessageW(GetAncestor(scintilla, GA_ROOT), message, 0, 0) != 1) result = 31;
    } else if (command == "open-review") {
        if (!InvokePluginCommand(GetAncestor(scintilla, GA_ROOT), L"Открыть текущий файл в Review")) result = 37;
    } else if (command == "comment-card") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !CommentCardMatches(processId, expected)) result = 32;
    } else if (command == "suggestion-visual") {
        if (!SuggestionVisualMatches(process, scintilla, text)) result = 29;
    } else if (command == "suggestion-hidden") {
        if (!SuggestionVisualHidden(process, scintilla)) result = 35;
    } else if (command == "set-suggestion-mode") {
        LRESULT mode = -1;
        const auto modeParsed = std::from_chars(text.data(), text.data() + text.size(), mode);
        if (modeParsed.ec != std::errc{} || !SetSuggestionMode(processId, mode)) result = 36;
    } else if (command == "accept-suggestion") {
        if (!AcceptFirstSuggestion(processId)) result = 30;
    } else if (command == "participant-count") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !ParticipantCountMatches(processId, expected)) result = 11;
    } else if (command == "conflict-count") {
        LRESULT expected = -1;
        const auto countParsed = std::from_chars(text.data(), text.data() + text.size(), expected);
        if (countParsed.ec != std::errc{} || !ConflictCountMatches(processId, expected)) result = 12;
    } else if (command == "resolve-current") {
        if (!ResolveFirstConflict(processId, false)) result = 13;
    } else if (command == "resolve-external") {
        if (!ResolveFirstConflict(processId, true)) result = 14;
    } else {
        std::cerr << "unknown command\n";
        result = 2;
    }
    CloseHandle(process);
    return result;
}
