#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <iphlpapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wrl.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <regex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "WebView2.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClass[] = L"EaWLocalisationHubReviewWindow";
const wchar_t* kWindowTitle = L"EaW Localisation Hub – Review";
const wchar_t* kEnglishWindowTitle = L"EaW Localisation Hub – English original";
bool g_russian = false;
constexpr wchar_t kEnglishMutexName[] = L"Local\\EaWLocalisationHubEnglishOriginal";
constexpr ULONG_PTR kNavigateCopyData = 0x45415746;
constexpr size_t kMaxCopyDataBytes = 131072;
constexpr UINT kWebViewFailed = WM_APP + 1;

HWND g_window = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
std::wstring g_url;
std::wstring g_origin;
std::wstring g_token;
std::wstring g_englishWindowKey;
unsigned long long g_navigationNumber = 0;
int g_exitCode = 0;
bool g_webviewReady = false;

using CreateEnvironmentFunction = HRESULT(STDAPICALLTYPE*)(
    PCWSTR,
    PCWSTR,
    ICoreWebView2EnvironmentOptions*,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

std::wstring ExecutablePath() {
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    buffer.resize(length);
    return buffer;
}

std::wstring ExecutableDirectory() {
    return std::filesystem::path(ExecutablePath()).parent_path().wstring();
}

std::wstring LocalDataDirectory() {
    wchar_t* value = nullptr;
    size_t length = 0;
    if (_wdupenv_s(&value, &length, L"LOCALAPPDATA") != 0 || !value) {
        return (std::filesystem::path(ExecutableDirectory()) / L"ReviewData").wstring();
    }
    std::wstring result = (std::filesystem::path(value) / L"EaWLocalisationHub" / L"WebView2").wstring();
    free(value);
    return result;
}

void InitialiseLanguage() {
    g_russian = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_RUSSIAN;
    const auto path = std::filesystem::path(LocalDataDirectory()).parent_path() / L"ui-language.json";
    std::ifstream stream(path, std::ios::binary);
    char buffer[4096]{};
    stream.read(buffer, sizeof(buffer));
    if (!stream.bad() && stream.gcount() < sizeof(buffer)) {
        const std::string saved(buffer, static_cast<size_t>(stream.gcount()));
        std::smatch match;
        if (std::regex_search(saved, match, std::regex(R"re("preference"\s*:\s*"(ru|en|auto)")re"))) {
            if (match[1] == "ru") g_russian = true;
            else if (match[1] == "en") g_russian = false;
        }
    }
    if (g_russian) {
        kWindowTitle = L"EaW Localisation Hub – Рецензирование";
        kEnglishWindowTitle = L"EaW Localisation Hub – Английский оригинал";
    }
}

const wchar_t* UiText(const wchar_t* russian, const wchar_t* english) {
    return g_russian ? russian : english;
}

std::wstring OriginFromUrl(std::wstring_view url) {
    constexpr std::wstring_view loopback = L"http://127.0.0.1";
    if (url.size() < loopback.size()
        || CompareStringOrdinal(url.data(), static_cast<int>(loopback.size()),
            loopback.data(), static_cast<int>(loopback.size()), TRUE) != CSTR_EQUAL) return {};
    auto authority = url.substr(loopback.size());
    authority = authority.substr(0, authority.find_first_of(L"/?#"));
    if (authority.empty()) return std::wstring(loopback);
    if (authority.front() != L':' || authority.size() == 1) return {};
    unsigned int port = 0;
    for (const wchar_t digit : authority.substr(1)) {
        if (digit < L'0' || digit > L'9') return {};
        port = port * 10 + (digit - L'0');
        if (port > 65535) return {};
    }
    if (port == 0) return {};
    return port == 80 ? std::wstring(loopback) : std::wstring(loopback) + L":" + std::to_wstring(port);
}

std::wstring SignWindowMessage(std::wstring_view purpose, std::wstring_view fragment = {});

bool IsAgentListener() {
    PWSTR localData = nullptr;
    const HRESULT knownFolder = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localData);
    const std::filesystem::path state = localData ? localData : L"";
    CoTaskMemFree(localData);
    if (FAILED(knownFolder) || state.empty()) return false;

    const auto separator = g_origin.rfind(L':');
    const std::wstring portText = separator > g_origin.find(L':')
        ? g_origin.substr(separator + 1) : L"80";
    const auto port = static_cast<u_short>(std::stoul(portText));
    std::ifstream record(state / L"EaWLocalisationHub" / L"review-host" / (portText + L".session"),
        std::ios::binary);
    std::array<char, 80> buffer{};
    record.read(buffer.data(), buffer.size());
    if (!record.eof()) return false;
    const std::string_view entry(buffer.data(), static_cast<size_t>(record.gcount()));
    const auto space = entry.find(' ');
    const auto proof = SignWindowMessage(L"endpoint");
    if (proof.empty() || space == std::string_view::npos || space == 0 || space > 10
        || entry.size() != space + 1 + proof.size() + 1 || entry.back() != '\n'
        || !std::equal(proof.begin(), proof.end(), entry.begin() + space + 1)) return false;
    unsigned long long pid = 0;
    for (const auto digit : entry.substr(0, space)) {
        if (digit < '0' || digit > '9') return false;
        pid = pid * 10 + (digit - '0');
    }
    if (!pid || pid > MAXDWORD) return false;

    DWORD size = 0;
    if (GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0)
        != ERROR_INSUFFICIENT_BUFFER) return false;
    // Other applications can open listeners between the sizing and reading calls.
    for (int attempt = 0; attempt < 3; ++attempt) {
        std::vector<DWORD> storage((size + sizeof(DWORD) - 1) / sizeof(DWORD));
        const auto result = GetExtendedTcpTable(storage.data(), &size, FALSE,
            AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (result == ERROR_INSUFFICIENT_BUFFER) continue;
        if (result != NO_ERROR) return false;
        const auto* table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(storage.data());
        for (DWORD index = 0; index < table->dwNumEntries; ++index) {
            const auto& row = table->table[index];
            if (row.dwLocalAddr == htonl(INADDR_LOOPBACK) && row.dwLocalPort == htons(port)
                && row.dwOwningPid == pid) return true;
        }
        return false;
    }
    return false;
}

std::wstring_view FragmentParameter(std::wstring_view fragment, std::wstring_view name) {
    while (!fragment.empty()) {
        const auto separator = fragment.find(L'&');
        const auto item = fragment.substr(0, separator);
        const auto equals = item.find(L'=');
        if (equals != std::wstring_view::npos && item.substr(0, equals) == name) return item.substr(equals + 1);
        if (separator == std::wstring_view::npos) break;
        fragment.remove_prefix(separator + 1);
    }
    return {};
}

bool IsEnglishOriginal(std::wstring_view fragment) {
    // URLSearchParams preserves the camel-case option name emitted by Agent.
    // Accept the older lower-case spelling as well so mixed local builds still
    // converge on the same singleton window.
    return FragmentParameter(fragment, L"readOnly") == L"english"
        || FragmentParameter(fragment, L"readonly") == L"english";
}

bool IsUrlFragment(std::wstring_view fragment) {
    return !fragment.empty() && std::all_of(fragment.begin(), fragment.end(), [](wchar_t c) {
        // Agent and PowerShell both percent-encode argument values.
        return c >= L'!' && c <= L'~' && c != L'#';
    });
}

std::wstring SignWindowMessage(std::wstring_view purpose, std::wstring_view fragment) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) return {};
    std::wstring input = std::wstring(purpose) + L"\n" + g_origin + L"\n" + std::wstring(fragment);
    std::array<unsigned char, 32> hash{};
    BCRYPT_HASH_HANDLE handle = nullptr;
    auto result = BCryptCreateHash(algorithm, &handle, nullptr, 0,
        reinterpret_cast<PUCHAR>(g_token.data()), static_cast<ULONG>(g_token.size() * sizeof(wchar_t)), 0);
    if (result >= 0) {
        result = BCryptHashData(handle, reinterpret_cast<PUCHAR>(input.data()),
            static_cast<ULONG>(input.size() * sizeof(wchar_t)), 0);
        if (result >= 0) result = BCryptFinishHash(handle, hash.data(), static_cast<ULONG>(hash.size()), 0);
        BCryptDestroyHash(handle);
    }
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (result < 0) return {};
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring signature;
    for (const auto byte : hash) {
        signature += hex[byte >> 4];
        signature += hex[byte & 15];
    }
    return signature;
}

bool SameSignature(std::wstring_view actual, std::wstring_view expected) {
    if (expected.empty() || actual.size() != expected.size()) return false;
    unsigned int difference = 0;
    for (size_t i = 0; i < expected.size(); ++i) difference |= actual[i] ^ expected[i];
    return difference == 0;
}

void ActivateWindow(HWND window) {
    if (!window) return;
    ShowWindow(window, SW_RESTORE);
    // A short topmost toggle reliably surfaces a window that was launched by a
    // click in another WebView2 process without leaving it permanently on top.
    SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    SetFocus(window);
}

bool NavigateExistingEnglishWindow(HWND window, const std::wstring& payload) {
    COPYDATASTRUCT message{};
    message.dwData = kNavigateCopyData;
    message.cbData = static_cast<DWORD>((payload.size() + 1) * sizeof(wchar_t));
    message.lpData = const_cast<wchar_t*>(payload.c_str());
    DWORD_PTR handled = 0;
    const LRESULT sent = SendMessageTimeoutW(window, WM_COPYDATA, 0,
        reinterpret_cast<LPARAM>(&message), SMTO_ABORTIFHUNG, 2000, &handled);
    if (!sent || !handled) return false;
    ActivateWindow(window);
    return true;
}

struct EnglishWindowSearch {
    const std::wstring& payload;
    const std::wstring& executable;
    bool handled = false;
};

BOOL CALLBACK FindEnglishWindow(HWND window, LPARAM context) {
    if (!GetPropW(window, g_englishWindowKey.c_str())) return TRUE;
    auto& search = *reinterpret_cast<EnglishWindowSearch*>(context);
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (!process) return TRUE;
    std::wstring image(32768, L'\0');
    DWORD size = static_cast<DWORD>(image.size());
    const bool sameExecutable = QueryFullProcessImageNameW(process, 0, image.data(), &size)
        && CompareStringOrdinal(image.data(), size, search.executable.data(),
            static_cast<int>(search.executable.size()), TRUE) == CSTR_EQUAL;
    CloseHandle(process);
    if (!sameExecutable) return TRUE;
    search.handled = NavigateExistingEnglishWindow(window, search.payload);
    return !search.handled;
}

void ResizeWebView() {
    if (!g_controller || !g_window) return;
    RECT bounds{};
    GetClientRect(g_window, &bounds);
    g_controller->put_Bounds(bounds);
}

void Fatal(const wchar_t* message) {
    g_exitCode = 1;
    MessageBoxW(g_window, message, kWindowTitle, MB_OK | MB_ICONERROR);
    if (g_window) DestroyWindow(g_window);
    else PostQuitMessage(g_exitCode);
}

void ReportWebViewFailure() {
    if (g_window) PostMessageW(g_window, kWebViewFailed, 0, 0);
}

template <typename Interface> const IID& InterfaceId();
template <> const IID& InterfaceId<ICoreWebView2NavigationStartingEventHandler>() {
    return IID_ICoreWebView2NavigationStartingEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2NewWindowRequestedEventHandler>() {
    return IID_ICoreWebView2NewWindowRequestedEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2PermissionRequestedEventHandler>() {
    return IID_ICoreWebView2PermissionRequestedEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2WebMessageReceivedEventHandler>() {
    return IID_ICoreWebView2WebMessageReceivedEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>() {
    return IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler;
}
template <> const IID& InterfaceId<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>() {
    return IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler;
}
template <> const IID& InterfaceId<ICoreWebView2DownloadStartingEventHandler>() {
    return IID_ICoreWebView2DownloadStartingEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2LaunchingExternalUriSchemeEventHandler>() {
    return IID_ICoreWebView2LaunchingExternalUriSchemeEventHandler;
}
template <> const IID& InterfaceId<ICoreWebView2SetPermissionStateCompletedHandler>() {
    return IID_ICoreWebView2SetPermissionStateCompletedHandler;
}

template <typename From, typename To>
HRESULT QueryWebViewInterface(From* from, const IID& iid, ComPtr<To>& to) {
    return from->QueryInterface(iid, reinterpret_cast<void**>(to.GetAddressOf()));
}

template <typename Interface>
class ComHandler : public Interface {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (id == IID_IUnknown || id == InterfaceId<Interface>()) {
            *result = static_cast<Interface*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = InterlockedDecrement(&references_);
        if (!remaining) delete this;
        return remaining;
    }
protected:
    virtual ~ComHandler() = default;
private:
    volatile LONG references_{1};
};

class NavigationHandler final : public ComHandler<ICoreWebView2NavigationStartingEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* arguments) override {
        LPWSTR uri = nullptr;
        const bool allowed = SUCCEEDED(arguments->get_Uri(&uri)) && uri
            && (std::wstring_view(uri) == L"about:blank"
                || (OriginFromUrl(uri) == g_origin && IsAgentListener()));
        CoTaskMemFree(uri);
        return allowed ? S_OK : arguments->put_Cancel(TRUE);
    }
};

class NewWindowHandler final : public ComHandler<ICoreWebView2NewWindowRequestedEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* arguments) override {
        return arguments->put_Handled(TRUE);
    }
};

class DownloadHandler final : public ComHandler<ICoreWebView2DownloadStartingEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* arguments) override {
        return arguments->put_Cancel(TRUE);
    }
};

class ExternalSchemeHandler final : public ComHandler<ICoreWebView2LaunchingExternalUriSchemeEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2LaunchingExternalUriSchemeEventArgs* arguments) override {
        return arguments->put_Cancel(TRUE);
    }
};

class ReviewMessageHandler final : public ComHandler<ICoreWebView2WebMessageReceivedEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* arguments) override {
        LPWSTR source = nullptr;
        LPWSTR message = nullptr;
        const bool fromReview = SUCCEEDED(arguments->get_Source(&source)) && source
            && OriginFromUrl(source) == g_origin;
        if (g_window && fromReview && SUCCEEDED(arguments->TryGetWebMessageAsString(&message)) && message
            && std::wstring_view(message) == L"hub-session-ended") {
            PostMessageW(g_window, WM_CLOSE, 0, 0);
        }
        CoTaskMemFree(source);
        CoTaskMemFree(message);
        return S_OK;
    }
};

class PermissionHandler final : public ComHandler<ICoreWebView2PermissionRequestedEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* arguments) override {
        COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
        LPWSTR uri = nullptr;
        const bool localFilePicker = SUCCEEDED(arguments->get_PermissionKind(&kind))
            && kind == COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE
            && SUCCEEDED(arguments->get_Uri(&uri)) && uri && OriginFromUrl(uri) == g_origin;
        CoTaskMemFree(uri);
        ComPtr<ICoreWebView2PermissionRequestedEventArgs3> persistence;
        if (SUCCEEDED(QueryWebViewInterface(arguments, IID_ICoreWebView2PermissionRequestedEventArgs3, persistence))) {
            const auto result = persistence->put_SavesInProfile(FALSE);
            if (FAILED(result)) return result;
        }
        return arguments->put_State(localFilePicker
            ? COREWEBVIEW2_PERMISSION_STATE_DEFAULT
            : COREWEBVIEW2_PERMISSION_STATE_DENY);
    }
};

bool NavigateReview() {
    if (!g_window) return false;
    if (!g_webviewReady) return true;
    if (SUCCEEDED(g_webview->Navigate(g_url.c_str()))) return true;
    ReportWebViewFailure();
    return false;
}

class PermissionResetHandler final : public ComHandler<ICoreWebView2SetPermissionStateCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result) override {
        if (!g_window) return S_OK;
        if (FAILED(result)) ReportWebViewFailure();
        else {
            g_webviewReady = true;
            NavigateReview();
        }
        return S_OK;
    }
};

HRESULT ConfigureWebView(ICoreWebView2Controller* controller) {
    g_controller = controller;
    HRESULT result = g_controller->get_CoreWebView2(&g_webview);
    if (FAILED(result) || !g_webview) return FAILED(result) ? result : E_POINTER;
    ComPtr<ICoreWebView2Settings> settings;
    ComPtr<ICoreWebView2Settings4> autofill;
    if (FAILED(g_webview->get_Settings(&settings)) || !settings
        || FAILED(settings->put_AreDefaultContextMenusEnabled(FALSE))
        || FAILED(settings->put_AreDevToolsEnabled(FALSE))
        || FAILED(settings->put_AreHostObjectsAllowed(FALSE))
        || FAILED(settings->put_IsStatusBarEnabled(FALSE))
        || FAILED(QueryWebViewInterface(settings.Get(), IID_ICoreWebView2Settings4, autofill))
        || FAILED(autofill->put_IsGeneralAutofillEnabled(FALSE))
        || FAILED(autofill->put_IsPasswordAutosaveEnabled(FALSE))) return E_FAIL;

    EventRegistrationToken registration{};
    ComPtr<NavigationHandler> navigationHandler;
    navigationHandler.Attach(new NavigationHandler());
    ComPtr<NewWindowHandler> newWindowHandler;
    newWindowHandler.Attach(new NewWindowHandler());
    ComPtr<PermissionHandler> permissionHandler;
    permissionHandler.Attach(new PermissionHandler());
    ComPtr<ReviewMessageHandler> messageHandler;
    messageHandler.Attach(new ReviewMessageHandler());
    ComPtr<DownloadHandler> downloadHandler;
    downloadHandler.Attach(new DownloadHandler());
    ComPtr<ExternalSchemeHandler> externalSchemeHandler;
    externalSchemeHandler.Attach(new ExternalSchemeHandler());
    ComPtr<ICoreWebView2_4> downloads;
    ComPtr<ICoreWebView2_18> externalSchemes;
    if (FAILED(g_webview->add_NavigationStarting(navigationHandler.Get(), &registration))
        || FAILED(g_webview->add_FrameNavigationStarting(navigationHandler.Get(), &registration))
        || FAILED(g_webview->add_NewWindowRequested(newWindowHandler.Get(), &registration))
        || FAILED(g_webview->add_PermissionRequested(permissionHandler.Get(), &registration))
        || FAILED(g_webview->add_WebMessageReceived(messageHandler.Get(), &registration))
        || FAILED(QueryWebViewInterface(g_webview.Get(), IID_ICoreWebView2_4, downloads))
        || FAILED(downloads->add_DownloadStarting(downloadHandler.Get(), &registration))
        || FAILED(QueryWebViewInterface(g_webview.Get(), IID_ICoreWebView2_18, externalSchemes))
        || FAILED(externalSchemes->add_LaunchingExternalUriScheme(externalSchemeHandler.Get(), &registration))) return E_FAIL;

    ComPtr<ICoreWebView2_13> viewWithProfile;
    ComPtr<ICoreWebView2Profile> profile;
    ComPtr<ICoreWebView2Profile4> permissions;
    if (FAILED(QueryWebViewInterface(g_webview.Get(), IID_ICoreWebView2_13, viewWithProfile))
        || FAILED(viewWithProfile->get_Profile(&profile)) || !profile
        || FAILED(QueryWebViewInterface(profile.Get(), IID_ICoreWebView2Profile4, permissions))) return E_FAIL;

    ResizeWebView();
    result = g_controller->put_IsVisible(TRUE);
    if (FAILED(result)) return result;
    // Earlier builds persisted a blanket file grant on this profile.
    ComPtr<PermissionResetHandler> resetHandler;
    resetHandler.Attach(new PermissionResetHandler());
    return permissions->SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
        g_origin.c_str(), COREWEBVIEW2_PERMISSION_STATE_DEFAULT, resetHandler.Get());
}

class ControllerCompletedHandler final
    : public ComHandler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
        if (!g_window) {
            if (controller) controller->Close();
            return S_OK;
        }
        if (FAILED(result) || !controller || FAILED(ConfigureWebView(controller))) ReportWebViewFailure();
        return S_OK;
    }
};

class EnvironmentCompletedHandler final
    : public ComHandler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* environment) override {
        if (!g_window) return S_OK;
        ComPtr<ControllerCompletedHandler> handler;
        handler.Attach(new ControllerCompletedHandler());
        if (FAILED(result) || !environment
            || FAILED(environment->CreateCoreWebView2Controller(g_window, handler.Get()))) ReportWebViewFailure();
        return S_OK;
    }
};

void CreateWebView() {
    const std::filesystem::path loaderPath = std::filesystem::path(ExecutableDirectory()) / L"WebView2Loader.dll";
    HMODULE loader = LoadLibraryExW(loaderPath.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!loader) {
        Fatal(UiText(L"Не найден WebView2Loader.dll рядом с EaWReview.exe.", L"WebView2Loader.dll was not found next to EaWReview.exe."));
        return;
    }
    auto createEnvironment = reinterpret_cast<CreateEnvironmentFunction>(
        GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!createEnvironment) {
        Fatal(UiText(L"WebView2Loader.dll не содержит требуемую функцию.", L"WebView2Loader.dll does not contain the required function."));
        return;
    }
    const std::wstring userData = LocalDataDirectory();
    ComPtr<EnvironmentCompletedHandler> handler;
    handler.Attach(new EnvironmentCompletedHandler());
    const HRESULT started = createEnvironment(
        nullptr,
        userData.c_str(),
        nullptr,
        handler.Get());
    if (FAILED(started)) Fatal(UiText(L"Не удалось запустить Microsoft Edge WebView2 Runtime.", L"Could not start Microsoft Edge WebView2 Runtime."));
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_COPYDATA: {
            const COPYDATASTRUCT* data = reinterpret_cast<const COPYDATASTRUCT*>(lParam);
            if (g_englishWindowKey.empty() || !data || data->dwData != kNavigateCopyData || !data->lpData
                || data->cbData < sizeof(wchar_t) || data->cbData > kMaxCopyDataBytes
                || data->cbData % sizeof(wchar_t) != 0) return FALSE;
            const size_t length = data->cbData / sizeof(wchar_t);
            const wchar_t* characters = static_cast<const wchar_t*>(data->lpData);
            if (characters[length - 1] != L'\0') return FALSE;
            const std::wstring_view payload(characters, length - 1);
            const auto separator = payload.find(L':');
            if (separator != 64) return FALSE;
            const auto fragment = payload.substr(separator + 1);
            if (!IsUrlFragment(fragment) || !IsEnglishOriginal(fragment)
                || !SameSignature(payload.substr(0, separator), SignWindowMessage(L"navigate", fragment))) return FALSE;
            // A different query forces a new document even when only the target fragment changes.
            g_url = g_origin + L"/?open=" + std::to_wstring(++g_navigationNumber)
                + L"#token=" + g_token + L"&" + std::wstring(fragment);
            if (!NavigateReview()) return FALSE;
            ActivateWindow(window);
            return TRUE;
        }
        case kWebViewFailed:
            Fatal(UiText(L"Не удалось настроить WebView2. Проверьте Microsoft Edge WebView2 Runtime.",
                L"Could not configure WebView2. Check the Microsoft Edge WebView2 Runtime."));
            return 0;
        case WM_SIZE:
            ResizeWebView();
            return 0;
        case WM_DPICHANGED: {
            const RECT* suggested = reinterpret_cast<const RECT*>(lParam);
            SetWindowPos(window, nullptr, suggested->left, suggested->top,
                suggested->right - suggested->left, suggested->bottom - suggested->top,
                SWP_NOACTIVATE | SWP_NOZORDER);
            return 0;
        }
        case WM_DESTROY:
            g_window = nullptr;
            g_webviewReady = false;
            if (!g_englishWindowKey.empty()) RemovePropW(window, g_englishWindowKey.c_str());
            if (g_controller) g_controller->Close();
            g_webview.Reset();
            g_controller.Reset();
            PostQuitMessage(g_exitCode);
            return 0;
        default:
            return DefWindowProcW(window, message, wParam, lParam);
    }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    InitialiseLanguage();
    SetProcessDPIAware();
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    int argumentCount = 0;
    wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (!arguments || argumentCount != 2) {
        MessageBoxW(nullptr, UiText(L"Запускайте Review через EaW Hub Agent или Launch EaW Hub Review.cmd.", L"Launch Review through EaW Hub Agent or Launch EaW Hub Review.cmd."), kWindowTitle, MB_OK | MB_ICONINFORMATION);
        if (arguments) LocalFree(arguments);
        CoUninitialize();
        return 2;
    }
    const std::wstring url = arguments[1];
    LocalFree(arguments);
    g_origin = OriginFromUrl(url);
    const auto root = url.find_first_of(L"/?#", std::wstring_view(L"http://").size());
    const auto launch = root == std::wstring::npos ? std::wstring_view{} : std::wstring_view(url).substr(root);
    constexpr std::wstring_view tokenPrefix = L"/#token=";
    const auto separator = launch.find(L'&');
    const auto token = launch.starts_with(tokenPrefix) && separator == tokenPrefix.size() + 43
        ? launch.substr(tokenPrefix.size(), 43) : std::wstring_view{};
    const auto fragment = token.empty() ? std::wstring_view{} : launch.substr(separator + 1);
    if (g_origin.empty() || !IsUrlFragment(fragment) || FragmentParameter(fragment, L"path").empty()
        || !std::all_of(token.begin(), token.end(), [](wchar_t c) {
            return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z')
                || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-';
        })) {
        MessageBoxW(nullptr, UiText(L"Некорректный адрес запуска Review.", L"Invalid Review launch address."),
            kWindowTitle, MB_OK | MB_ICONERROR);
        CoUninitialize();
        return 3;
    }
    g_token = token;
    if (!IsAgentListener()) {
        MessageBoxW(nullptr, UiText(L"Не удалось подтвердить локальное подключение к Desktop Agent. Перезапустите Agent и откройте Review снова.",
            L"Could not verify the local Desktop Agent. Restart Agent and open Review again."),
            kWindowTitle, MB_OK | MB_ICONERROR);
        CoUninitialize();
        return 3;
    }
    g_url = g_origin + std::wstring(launch);

    const bool englishOriginal = IsEnglishOriginal(fragment);
    HANDLE englishMutex = nullptr;
    bool ownsEnglishMutex = false;
    if (englishOriginal) {
        const auto sessionId = SignWindowMessage(L"window");
        const auto signature = SignWindowMessage(L"navigate", fragment);
        if (sessionId.empty() || signature.empty()) {
            CoUninitialize();
            return 4;
        }
        const std::wstring payload = signature + L":" + std::wstring(fragment);
        if ((payload.size() + 1) * sizeof(wchar_t) > kMaxCopyDataBytes) {
            CoUninitialize();
            return 3;
        }
        g_englishWindowKey = std::wstring(kWindowClass) + L"-" + sessionId;
        const std::wstring mutexName = std::wstring(kEnglishMutexName) + L"-" + sessionId;
        englishMutex = CreateMutexW(nullptr, TRUE, mutexName.c_str());
        if (!englishMutex) {
            CoUninitialize();
            return 4;
        }
        ownsEnglishMutex = GetLastError() != ERROR_ALREADY_EXISTS;
        if (!ownsEnglishMutex) {
            // The first process may still be between creating the mutex and its
            // HWND. Give it a brief chance to publish the reusable window.
            const auto executable = ExecutablePath();
            const auto deadline = GetTickCount64() + 3000;
            do {
                EnglishWindowSearch search{payload, executable};
                EnumWindows(FindEnglishWindow, reinterpret_cast<LPARAM>(&search));
                if (search.handled) {
                    CloseHandle(englishMutex);
                    CoUninitialize();
                    return 0;
                }
                Sleep(50);
            } while (GetTickCount64() < deadline);
            const DWORD acquired = WaitForSingleObject(englishMutex, 1000);
            ownsEnglishMutex = acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED;
            if (!ownsEnglishMutex) {
                CloseHandle(englishMutex);
                CoUninitialize();
                return 4;
            }
        }
    }

    WNDCLASSEXW windowClass{sizeof(WNDCLASSEXW)};
    windowClass.lpfnWndProc = WindowProcedure;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = kWindowClass;
    if (!RegisterClassExW(&windowClass)) {
        if (ownsEnglishMutex) ReleaseMutex(englishMutex);
        if (englishMutex) CloseHandle(englishMutex);
        CoUninitialize();
        return 5;
    }
    const wchar_t* windowTitle = englishOriginal ? kEnglishWindowTitle : kWindowTitle;
    g_window = CreateWindowExW(0, kWindowClass, windowTitle, WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1500, 900, nullptr, nullptr, instance, nullptr);
    if (!g_window) {
        if (ownsEnglishMutex) ReleaseMutex(englishMutex);
        if (englishMutex) CloseHandle(englishMutex);
        CoUninitialize();
        return 6;
    }
    if (englishOriginal && !SetPropW(g_window, g_englishWindowKey.c_str(), g_window)) {
        Fatal(UiText(L"Не удалось зарегистрировать окно английского оригинала.",
            L"Could not register the English original window."));
    }
    if (g_window) {
        ShowWindow(g_window, showCommand);
        UpdateWindow(g_window);
        // Surface the English original when it was opened from another window.
        ActivateWindow(g_window);
        CreateWebView();
    }

    MSG message{};
    BOOL status;
    while ((status = GetMessageW(&message, nullptr, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    if (ownsEnglishMutex) ReleaseMutex(englishMutex);
    if (englishMutex) CloseHandle(englishMutex);
    CoUninitialize();
    return status < 0 ? 1 : static_cast<int>(message.wParam);
}
