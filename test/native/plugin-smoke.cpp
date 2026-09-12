#include <windows.h>

#include <iostream>
#include <string>

struct MenuItemAbi {
    wchar_t itemName[64];
    void (*command)();
    int commandId;
    bool initiallyChecked;
    void* shortcut;
};

struct NppDataAbi {
    HWND notepad;
    HWND scintillaMain;
    HWND scintillaSecond;
};

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
    using GetFunctions = MenuItemAbi* (*)(int*);
    using SetInfo = void (*)(NppDataAbi);
    using IsUnicode = BOOL (*)();
    const auto getName = reinterpret_cast<GetName>(GetProcAddress(module, "getName"));
    const auto getFunctions = reinterpret_cast<GetFunctions>(GetProcAddress(module, "getFuncsArray"));
    const auto setInfo = reinterpret_cast<SetInfo>(GetProcAddress(module, "setInfo"));
    const auto isUnicode = reinterpret_cast<IsUnicode>(GetProcAddress(module, "isUnicode"));
    const std::wstring actualName = getName();
    const std::wstring expectedName = L"EaW Localisation Hub 0.8.7F8";
    if (actualName != expectedName || !isUnicode()) {
        std::wcerr << L"unexpected ABI metadata: " << actualName << L"\n";
        FreeLibrary(module);
        return 5;
    }

    setInfo({});
    int commandCount = 0;
    const MenuItemAbi* commands = getFunctions(&commandCount);
    if (commandCount != 1 || !commands || !commands[0].command
        || std::wstring(commands[0].itemName) != L"Открыть текущий файл в Review"
        || commands[0].initiallyChecked || commands[0].shortcut) {
        std::cerr << "unexpected plugin command surface\n";
        FreeLibrary(module);
        return 6;
    }

    std::wcout << L"[native-smoke] loaded Review-only bridge " << actualName << L"\n";
    FreeLibrary(module);
    return 0;
}
