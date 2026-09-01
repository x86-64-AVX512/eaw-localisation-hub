#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <wincred.h>

#include "IpcSecurity.h"

#include <array>
#include <vector>

namespace eaw::ipc {
namespace {

constexpr wchar_t kDefaultPipeName[] = L"eaw-localisation-hub";
constexpr wchar_t kIpcCredentialTarget[] = L"EaWLocalisationHub.IpcSecret";

std::string WideToUtf8(std::wstring_view value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring Utf8ToWide(std::string_view value) {
    if (value.empty()) return {};
    const int size = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

bool Sha256(std::string_view value, std::vector<BYTE>& digest) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return false;
    const bool created = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) == TRUE;
    bool success = created
        && CryptHashData(
            hash,
            reinterpret_cast<const BYTE*>(value.data()),
            static_cast<DWORD>(value.size()),
            0) == TRUE;
    DWORD length = 32;
    digest.assign(length, 0);
    success = success && CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &length, 0) == TRUE && length == 32;
    if (hash) CryptDestroyHash(hash);
    CryptReleaseContext(provider, 0);
    if (!success) digest.clear();
    return success;
}

std::string Hex(const std::vector<BYTE>& bytes) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string result;
    result.reserve(bytes.size() * 2);
    for (const BYTE value : bytes) {
        result.push_back(digits[value >> 4]);
        result.push_back(digits[value & 0x0F]);
    }
    return result;
}

}  // namespace

std::string HmacSha256(std::string_view secret, std::string_view value) {
    std::vector<BYTE> key(secret.begin(), secret.end());
    if (key.size() > 64) {
        std::vector<BYTE> shortened;
        if (!Sha256(secret, shortened)) return {};
        key = std::move(shortened);
    }
    key.resize(64, 0);
    std::string inner(64, '\0');
    std::string outer(64, '\0');
    for (size_t index = 0; index < 64; ++index) {
        inner[index] = static_cast<char>(key[index] ^ 0x36);
        outer[index] = static_cast<char>(key[index] ^ 0x5c);
    }
    inner.append(value.data(), value.size());
    std::vector<BYTE> innerDigest;
    if (!Sha256(inner, innerDigest)) return {};
    outer.append(reinterpret_cast<const char*>(innerDigest.data()), innerDigest.size());
    std::vector<BYTE> result;
    return Sha256(outer, result) ? Hex(result) : std::string{};
}

bool ConstantTimeHexEqual(std::string_view left, std::string_view right) {
    if (left.size() != right.size() || left.empty()) return false;
    unsigned char difference = 0;
    for (size_t index = 0; index < left.size(); ++index) {
        difference |= static_cast<unsigned char>(left[index] ^ right[index]);
    }
    return difference == 0;
}

std::string ReadIpcSecret() {
    std::array<wchar_t, 512> environment{};
    const DWORD environmentLength = GetEnvironmentVariableW(
        L"EAW_HUB_IPC_SECRET", environment.data(), static_cast<DWORD>(environment.size()));
    if (environmentLength >= 32 && environmentLength < environment.size()) {
        return WideToUtf8(std::wstring_view(environment.data(), environmentLength));
    }
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(kIpcCredentialTarget, CRED_TYPE_GENERIC, 0, &credential)) return {};
    std::string secret;
    if (credential->CredentialBlobSize >= 64 && credential->CredentialBlob) {
        const auto* text = reinterpret_cast<const wchar_t*>(credential->CredentialBlob);
        secret = WideToUtf8(std::wstring_view(text, credential->CredentialBlobSize / sizeof(wchar_t)));
    }
    CredFree(credential);
    return secret;
}

std::wstring DerivedPipeName(std::string_view secret) {
    std::vector<BYTE> digest;
    if (!Sha256(secret, digest)) return {};
    return std::wstring(kDefaultPipeName) + L"-" + Utf8ToWide(Hex(digest).substr(0, 24));
}

}  // namespace eaw::ipc
