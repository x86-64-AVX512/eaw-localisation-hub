#pragma once

#include <string>
#include <string_view>

namespace eaw::ipc {

std::string HmacSha256(std::string_view secret, std::string_view value);
bool ConstantTimeHexEqual(std::string_view left, std::string_view right);
std::string ReadIpcSecret();
std::wstring DerivedPipeName(std::string_view secret);

}  // namespace eaw::ipc
