#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstddef>
#include <string>

#include "PluginInterface.h"

namespace eaw::editor {

HWND CurrentScintilla(const NppData& nppData);
std::wstring CurrentPath(const NppData& nppData);
std::wstring PathFromBufferId(const NppData& nppData, UINT_PTR bufferId);
std::string WideToUtf8(const std::wstring& value);
std::wstring Utf8ToWide(const std::string& value);
std::string NormalisePath(std::string pathValue);
bool IsTrackedPath(const std::wstring& pathValue);
std::string Base64Encode(const char* data, size_t length);
std::string Base64Decode(const std::string& encoded);

}  // namespace eaw::editor
