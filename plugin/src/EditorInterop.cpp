#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>

#include "EditorInterop.h"

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <vector>

namespace eaw::editor {

HWND CurrentScintilla(const NppData& nppData) {
    int view = 0;
    if (nppData._nppHandle) {
        SendMessageW(nppData._nppHandle, NPPM_GETCURRENTSCINTILLA, 0, reinterpret_cast<LPARAM>(&view));
    }
    return view == 1 ? nppData._scintillaSecondHandle : nppData._scintillaMainHandle;
}

std::wstring CurrentPath(const NppData& nppData) {
    if (!nppData._nppHandle) return {};
    std::vector<wchar_t> buffer(32768, L'\0');
    SendMessageW(
        nppData._nppHandle,
        NPPM_GETFULLCURRENTPATH,
        static_cast<WPARAM>(buffer.size()),
        reinterpret_cast<LPARAM>(buffer.data()));
    return std::wstring(buffer.data());
}

std::wstring PathFromBufferId(const NppData& nppData, UINT_PTR bufferId) {
    if (!nppData._nppHandle || !bufferId) return {};
    const LRESULT length = SendMessageW(nppData._nppHandle, NPPM_GETFULLPATHFROMBUFFERID, bufferId, 0);
    if (length <= 0) return {};
    std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1, L'\0');
    SendMessageW(
        nppData._nppHandle,
        NPPM_GETFULLPATHFROMBUFFERID,
        bufferId,
        reinterpret_cast<LPARAM>(buffer.data()));
    return std::wstring(buffer.data());
}

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int size = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::string NormalisePath(std::string pathValue) {
    for (char& character : pathValue) {
        if (character == '/') character = '\\';
        else character = static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
    }
    return pathValue;
}

bool IsTrackedPath(const std::wstring& pathValue) {
    if (pathValue.empty()) return false;
    std::wstring lower = pathValue;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](wchar_t value) {
        return static_cast<wchar_t>(std::towlower(value));
    });
    std::replace(lower.begin(), lower.end(), L'/', L'\\');
    constexpr wchar_t russianMarker[] = L"\\localisation\\russian\\";
    constexpr wchar_t englishMarker[] = L"\\localisation\\english\\";
    constexpr wchar_t replaceMarker[] = L"\\localisation\\replace\\";
    return (lower.find(russianMarker) != std::wstring::npos
            || lower.find(englishMarker) != std::wstring::npos
            || lower.find(replaceMarker) != std::wstring::npos)
        && lower.size() >= 4
        && lower.substr(lower.size() - 4) == L".yml";
}

std::string Base64Encode(const char* data, size_t length) {
    if (length == 0) return {};
    DWORD outputLength = 0;
    if (!CryptBinaryToStringA(
            reinterpret_cast<const BYTE*>(data), static_cast<DWORD>(length),
            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &outputLength)) return {};
    std::string output(outputLength, '\0');
    if (!CryptBinaryToStringA(
            reinterpret_cast<const BYTE*>(data), static_cast<DWORD>(length),
            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, output.data(), &outputLength)) return {};
    while (!output.empty() && output.back() == '\0') output.pop_back();
    return output;
}

std::string Base64Decode(const std::string& encoded) {
    if (encoded.empty()) return {};
    DWORD outputLength = 0;
    if (!CryptStringToBinaryA(
            encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64,
            nullptr, &outputLength, nullptr, nullptr)) return {};
    std::string output(outputLength, '\0');
    if (!CryptStringToBinaryA(
            encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64,
            reinterpret_cast<BYTE*>(output.data()), &outputLength, nullptr, nullptr)) return {};
    output.resize(outputLength);
    return output;
}

}  // namespace eaw::editor
