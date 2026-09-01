#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wrl.h>

#include <algorithm>
#include <filesystem>
#include <string>

#include "WebView2.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClass[] = L"EaWLocalisationHubReviewWindow";
constexpr wchar_t kWindowTitle[] = L"EaW Localisation Hub — Рецензирование";

HWND g_window = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
std::wstring g_url;
std::wstring g_origin;

using CreateEnvironmentFunction = HRESULT(STDAPICALLTYPE*)(
    PCWSTR,
    PCWSTR,
    ICoreWebView2EnvironmentOptions*,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

std::wstring ExecutableDirectory() {
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path().wstring();
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

std::wstring OriginFromUrl(const std::wstring& url) {
    const size_t scheme = url.find(L"://");
    if (scheme == std::wstring::npos) return {};
    const size_t slash = url.find(L'/', scheme + 3);
    return slash == std::wstring::npos ? url : url.substr(0, slash);
}

bool AllowedNavigation(const std::wstring& uri) {
    if (uri == L"about:blank") return true;
    if (!uri.starts_with(g_origin)) return false;
    return uri.size() == g_origin.size() || uri[g_origin.size()] == L'/';
}

void ResizeWebView() {
    if (!g_controller || !g_window) return;
    RECT bounds{};
    GetClientRect(g_window, &bounds);
    g_controller->put_Bounds(bounds);
}

void Fatal(const wchar_t* message) {
    MessageBoxW(g_window, message, kWindowTitle, MB_OK | MB_ICONERROR);
    if (g_window) DestroyWindow(g_window);
    else PostQuitMessage(1);
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
template <> const IID& InterfaceId<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>() {
    return IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler;
}
template <> const IID& InterfaceId<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>() {
    return IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler;
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
        if (SUCCEEDED(arguments->get_Uri(&uri)) && uri) {
            const bool allowed = AllowedNavigation(uri);
            CoTaskMemFree(uri);
            if (!allowed) arguments->put_Cancel(TRUE);
        }
        return S_OK;
    }
};

class NewWindowHandler final : public ComHandler<ICoreWebView2NewWindowRequestedEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* arguments) override {
        arguments->put_Handled(TRUE);
        return S_OK;
    }
};

class PermissionHandler final : public ComHandler<ICoreWebView2PermissionRequestedEventHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* arguments) override {
        COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
        LPWSTR uri = nullptr;
        const bool localFileSave = SUCCEEDED(arguments->get_PermissionKind(&kind))
            && kind == COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE
            && SUCCEEDED(arguments->get_Uri(&uri)) && uri && AllowedNavigation(uri);
        if (uri) CoTaskMemFree(uri);
        arguments->put_State(localFileSave
            ? COREWEBVIEW2_PERMISSION_STATE_ALLOW
            : COREWEBVIEW2_PERMISSION_STATE_DENY);
        return S_OK;
    }
};

void ConfigureWebView(ICoreWebView2Controller* controller) {
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_webview);
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(g_webview->get_Settings(&settings))) {
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(TRUE);
    }
    EventRegistrationToken navigationToken{};
    ComPtr<NavigationHandler> navigationHandler;
    navigationHandler.Attach(new NavigationHandler());
    g_webview->add_NavigationStarting(navigationHandler.Get(), &navigationToken);
    EventRegistrationToken newWindowToken{};
    ComPtr<NewWindowHandler> newWindowHandler;
    newWindowHandler.Attach(new NewWindowHandler());
    g_webview->add_NewWindowRequested(newWindowHandler.Get(), &newWindowToken);
    EventRegistrationToken permissionToken{};
    ComPtr<PermissionHandler> permissionHandler;
    permissionHandler.Attach(new PermissionHandler());
    g_webview->add_PermissionRequested(permissionHandler.Get(), &permissionToken);
    ResizeWebView();
    g_controller->put_IsVisible(TRUE);
    g_webview->Navigate(g_url.c_str());
}

class ControllerCompletedHandler final
    : public ComHandler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
        if (FAILED(result) || !controller) {
            Fatal(L"Не удалось создать окно WebView2.");
            return result;
        }
        ConfigureWebView(controller);
        return S_OK;
    }
};

class EnvironmentCompletedHandler final
    : public ComHandler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* environment) override {
        if (FAILED(result) || !environment) {
            Fatal(L"Microsoft Edge WebView2 Runtime недоступен или повреждён.");
            return result;
        }
        ComPtr<ControllerCompletedHandler> handler;
        handler.Attach(new ControllerCompletedHandler());
        return environment->CreateCoreWebView2Controller(g_window, handler.Get());
    }
};

void CreateWebView() {
    const std::filesystem::path loaderPath = std::filesystem::path(ExecutableDirectory()) / L"WebView2Loader.dll";
    HMODULE loader = LoadLibraryExW(loaderPath.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!loader) {
        Fatal(L"Не найден WebView2Loader.dll рядом с EaWReview.exe.");
        return;
    }
    auto createEnvironment = reinterpret_cast<CreateEnvironmentFunction>(
        GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!createEnvironment) {
        Fatal(L"WebView2Loader.dll не содержит требуемую функцию.");
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
    if (FAILED(started)) Fatal(L"Не удалось запустить Microsoft Edge WebView2 Runtime.");
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
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
            g_webview.Reset();
            g_controller.Reset();
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(window, message, wParam, lParam);
    }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    SetProcessDPIAware();
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    int argumentCount = 0;
    wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (!arguments || argumentCount != 2) {
        MessageBoxW(nullptr, L"Запускайте Review через EaW Hub Agent или Launch EaW Hub Review.cmd.", kWindowTitle, MB_OK | MB_ICONINFORMATION);
        if (arguments) LocalFree(arguments);
        CoUninitialize();
        return 2;
    }
    g_url = arguments[1];
    LocalFree(arguments);
    g_origin = OriginFromUrl(g_url);
    if (!g_origin.starts_with(L"http://127.0.0.1:")) {
        MessageBoxW(nullptr, L"Review отказывается открывать нелокальный адрес.", kWindowTitle, MB_OK | MB_ICONERROR);
        CoUninitialize();
        return 3;
    }

    WNDCLASSEXW windowClass{sizeof(WNDCLASSEXW)};
    windowClass.lpfnWndProc = WindowProcedure;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = kWindowClass;
    if (!RegisterClassExW(&windowClass)) return 4;
    g_window = CreateWindowExW(0, kWindowClass, kWindowTitle, WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1500, 900, nullptr, nullptr, instance, nullptr);
    if (!g_window) return 5;
    ShowWindow(g_window, showCommand);
    UpdateWindow(g_window);
    CreateWebView();

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    CoUninitialize();
    return static_cast<int>(message.wParam);
}
