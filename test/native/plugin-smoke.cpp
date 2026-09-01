#include <windows.h>

#include <iostream>
#include <string>

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: plugin-smoke <plugin.dll>\n";
        return 2;
    }

    const HMODULE module = LoadLibraryA(argv[1]);
    if (!module) {
        std::cerr << "LoadLibraryA failed: " << GetLastError() << "\n";
        return 3;
    }

    const char* exports[] = {
        "setInfo",
        "getName",
        "getFuncsArray",
        "beNotified",
        "messageProc",
        "isUnicode",
    };
    for (const char* name : exports) {
        if (!GetProcAddress(module, name)) {
            std::cerr << "missing export: " << name << "\n";
            FreeLibrary(module);
            return 4;
        }
    }

    using GetName = const wchar_t* (*)();
    using IsUnicode = BOOL (*)();
    const auto getName = reinterpret_cast<GetName>(GetProcAddress(module, "getName"));
    const auto isUnicode = reinterpret_cast<IsUnicode>(GetProcAddress(module, "isUnicode"));
    const std::wstring actualName = getName();
    const std::wstring expectedName = L"EaW Localisation Hub 0.8.6F4";
    if (actualName != expectedName || !isUnicode()) {
        std::wcerr << L"unexpected ABI metadata: " << actualName << L"\n";
        FreeLibrary(module);
        return 5;
    }

    std::wcout << L"[native-smoke] loaded " << actualName << L"\n";
    FreeLibrary(module);
    return 0;
}
