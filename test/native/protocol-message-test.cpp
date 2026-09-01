#include <iostream>
#include <string>

#include "ProtocolMessage.h"
#include "PluginLifecycle.h"
#include "IpcSecurity.h"
#include "EditorInterop.h"
#include "VisualStyle.h"

namespace {

bool ExpectRejected(const std::string& input) {
    std::string error;
    return !eaw::protocol::Message::Parse(input, error) && !error.empty();
}

}  // namespace

int main() {
    const std::string utf8 = "Привет";
    if (eaw::editor::WideToUtf8(eaw::editor::Utf8ToWide(utf8)) != utf8
        || eaw::editor::Base64Decode(eaw::editor::Base64Encode(utf8.data(), utf8.size())) != utf8
        || !eaw::editor::IsTrackedPath(L"C:\\repo\\localisation\\russian\\x_l_russian.yml")
        || !eaw::editor::IsTrackedPath(L"C:\\repo\\localisation\\english\\x_l_english.yml")
        || !eaw::editor::IsTrackedPath(L"C:\\repo\\localisation\\replace\\english\\x_l_english.yml")
        || eaw::editor::IsTrackedPath(L"C:\\repo\\localisation\\unsupported\\x.yml")) {
        std::cerr << "editor interop primitives failed\n";
        return 1;
    }
    if (eaw::ipc::HmacSha256("key", "The quick brown fox jumps over the lazy dog")
            != "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        || !eaw::ipc::ConstantTimeHexEqual("aabb", "aabb")
        || eaw::ipc::ConstantTimeHexEqual("aabb", "aabc")) {
        std::cerr << "IPC cryptographic primitives failed\n";
        return 1;
    }
    if (eaw::visual::ColorFromString("#112233") != RGB(0x11, 0x22, 0x33)
        || eaw::visual::ColorFromString("invalid", RGB(1, 2, 3)) != RGB(1, 2, 3)) {
        std::cerr << "visual color parsing failed\n";
        return 1;
    }
    const RECT first{0, 0, 10, 10};
    const RECT overlapping{9, 9, 20, 20};
    const RECT adjacent{10, 0, 20, 10};
    if (!eaw::visual::RectanglesOverlap(first, overlapping)
        || eaw::visual::RectanglesOverlap(first, adjacent)) {
        std::cerr << "visual rectangle geometry failed\n";
        return 1;
    }

    eaw::plugin::Lifecycle lifecycle;
    if (lifecycle.Connected() || lifecycle.Ready()) return 1;
    if (!lifecycle.Connect() || !lifecycle.Connected()) return 1;
    lifecycle.AgentHello();
    lifecycle.SetDocumentStatus("syncing");
    if (lifecycle.Ready()) return 1;
    lifecycle.DocumentReady();
    if (!lifecycle.Ready() || !lifecycle.Online()) return 1;
    lifecycle.WorkspaceChanged();
    if (!lifecycle.BranchBlocked() || lifecycle.Ready()) return 1;
    lifecycle.Disconnect();
    if (lifecycle.Connected()) return 1;

    std::string error;
    auto notice = eaw::protocol::Message::Parse(
        R"({"message":"nested-looking: \"type\":\"replace\" and \u041f\u0440\u0438\u0432\u0435\u0442","type":"notice"})",
        error);
    if (!notice || notice->Type() != "notice"
        || notice->String("message") != "nested-looking: \"type\":\"replace\" and Привет") {
        std::cerr << "valid escaped/unicode JSON was not decoded correctly: " << error << '\n';
        return 1;
    }

    auto replace = eaw::protocol::Message::Parse(
        R"({"type":"replace","path":"C:\\repo\\localisation\\russian\\x.yml","positionByte":3,"deleteBytes":2,"insertBase64":"0J/RgNC40LLQtdGC","source":"workspace"})",
        error);
    if (!replace || replace->Integer("positionByte") != 3
        || replace->String("insertBase64") != "0J/RgNC40LLQtdGC"
        || replace->String("source") != "workspace") {
        std::cerr << "valid replace message was rejected: " << error << '\n';
        return 1;
    }

    if (!ExpectRejected(R"({"type":"replace","path":"x.yml","positionByte":"3","deleteBytes":2,"insertBase64":""})")
        || !ExpectRejected(R"({"type":"replace","positionByte":3,"deleteBytes":2,"insertBase64":""})")
        || !ExpectRejected(R"({"type":"madeUp","message":"ignored"})")
        || !ExpectRejected(R"({"type":"notice","message":"unterminated})")) {
        std::cerr << "invalid protocol input was accepted\n";
        return 1;
    }

    const std::string original = "quote=\" slash=\\ newline=\n";
    const std::string encoded = "{\"type\":\"notice\",\"message\":\""
        + eaw::protocol::EscapeString(original) + "\"}";
    auto roundTrip = eaw::protocol::Message::Parse(encoded, error);
    if (!roundTrip || roundTrip->String("message") != original) {
        std::cerr << "JSON string encoding failed to round-trip\n";
        return 1;
    }

    std::cout << "protocol message tests passed\n";
    return 0;
}
