#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

namespace eaw::plugin {

class LegacyIntegrationSettings final {
public:
    static bool Load(HWND notepadWindow);
    static void Save(HWND notepadWindow, bool enabled);
};

}  // namespace eaw::plugin
