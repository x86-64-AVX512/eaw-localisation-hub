#include "LegacyIntegrationSettings.h"

#include <string>
#include <vector>

#include "PluginInterface.h"

namespace eaw::plugin {
namespace {

constexpr wchar_t kSection[] = L"LegacyIntegration";
constexpr wchar_t kEnabled[] = L"Enabled";

std::wstring SettingsPath(HWND notepadWindow) {
    std::vector<wchar_t> directory(32768, L'\0');
    const LRESULT length = SendMessageW(
        notepadWindow,
        NPPM_GETPLUGINSCONFIGDIR,
        static_cast<WPARAM>(directory.size()),
        reinterpret_cast<LPARAM>(directory.data()));
    if (length <= 0 || static_cast<size_t>(length) >= directory.size()) return {};
    std::wstring result(directory.data(), static_cast<size_t>(length));
    if (!result.empty() && result.back() != L'\\' && result.back() != L'/') result.push_back(L'\\');
    return result + L"EawLocalisationHub.ini";
}

}  // namespace

bool LegacyIntegrationSettings::Load(HWND notepadWindow) {
    const std::wstring settings = SettingsPath(notepadWindow);
    return !settings.empty()
        && GetPrivateProfileIntW(kSection, kEnabled, 0, settings.c_str()) == 1;
}

void LegacyIntegrationSettings::Save(HWND notepadWindow, bool enabled) {
    const std::wstring settings = SettingsPath(notepadWindow);
    if (!settings.empty()) {
        WritePrivateProfileStringW(kSection, kEnabled, enabled ? L"1" : L"0", settings.c_str());
    }
}

}  // namespace eaw::plugin
