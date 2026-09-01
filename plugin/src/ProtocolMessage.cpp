#include "ProtocolMessage.h"

#include <array>
#include <limits>
#include <stdexcept>
#include <unordered_set>

#include <nlohmann/json.hpp>

namespace eaw::protocol {
namespace {

using Json = nlohmann::json;

constexpr std::size_t kMaximumFields = 40;
constexpr std::size_t kMaximumTypeBytes = 64;
constexpr std::size_t kMaximumPathBytes = 32 * 1024;
constexpr std::size_t kMaximumTextBytes = 12 * 1024 * 1024;
constexpr std::int64_t kMaximumPosition = std::numeric_limits<std::int32_t>::max();

const std::unordered_set<std::string> kKnownTypes{
    "ipcChallenge", "agentHello", "documentStatus", "documentReady", "workspaceChanged",
    "externalConflictReset", "externalConflict", "saveRequested", "replace",
    "reservationReset", "reservationTargetReset", "reservationTarget", "reservation",
    "commentReset", "commentThread", "commentMessage", "suggestionReset", "suggestion",
    "suggestionMessage", "presenceReset", "presence", "error", "notice",
};

bool RequireString(
    const Json& value,
    std::string_view key,
    std::size_t maximumBytes,
    std::string& error,
    bool allowEmpty = true) {
    const auto iterator = value.find(std::string(key));
    if (iterator == value.end() || !iterator->is_string()) {
        error = "field '" + std::string(key) + "' must be a string";
        return false;
    }
    const auto& text = iterator->get_ref<const std::string&>();
    if ((!allowEmpty && text.empty()) || text.size() > maximumBytes) {
        error = "field '" + std::string(key) + "' has an invalid length";
        return false;
    }
    return true;
}

bool RequireInteger(
    const Json& value,
    std::string_view key,
    std::int64_t minimum,
    std::int64_t maximum,
    std::string& error) {
    const auto iterator = value.find(std::string(key));
    if (iterator == value.end() || !iterator->is_number_integer()) {
        error = "field '" + std::string(key) + "' must be an integer";
        return false;
    }
    try {
        const auto number = iterator->get<std::int64_t>();
        if (number < minimum || number > maximum) {
            error = "field '" + std::string(key) + "' is outside the accepted range";
            return false;
        }
    } catch (const Json::exception&) {
        error = "field '" + std::string(key) + "' is outside the accepted range";
        return false;
    }
    return true;
}

bool RequirePath(const Json& value, std::string& error) {
    return RequireString(value, "path", kMaximumPathBytes, error, false);
}

bool RequireStrings(
    const Json& value,
    std::initializer_list<std::string_view> keys,
    std::size_t maximumBytes,
    std::string& error) {
    for (const auto key : keys) {
        if (!RequireString(value, key, maximumBytes, error)) return false;
    }
    return true;
}

bool RequirePositions(
    const Json& value,
    std::initializer_list<std::string_view> keys,
    std::string& error) {
    for (const auto key : keys) {
        if (!RequireInteger(value, key, 0, kMaximumPosition, error)) return false;
    }
    return true;
}

bool ValidateSchema(const Json& value, const std::string& type, std::string& error) {
    if (type == "ipcChallenge") {
        return RequireString(value, "nonce", 64, error, false)
            && value["nonce"].get_ref<const std::string&>().size() == 64
            && RequireString(value, "agentProof", 64, error, false)
            && value["agentProof"].get_ref<const std::string&>().size() == 64
            && RequireInteger(value, "protocol", 0, 1000, error);
    }
    if (type == "agentHello") {
        return RequireStrings(value, {"user", "userId", "color", "workspace"}, 1024, error);
    }
    if (type == "workspaceChanged" || type == "error" || type == "notice") {
        return RequireString(value, "message", 64 * 1024, error);
    }
    if (!RequirePath(value, error)) return false;

    if (type == "documentStatus") return RequireString(value, "status", 64, error, false);
    if (type == "documentReady" || type == "externalConflictReset" || type == "saveRequested"
        || type == "reservationReset" || type == "reservationTargetReset" || type == "commentReset"
        || type == "suggestionReset" || type == "presenceReset") return true;
    if (type == "externalConflict") {
        return RequireStrings(value, {"key", "label", "detail"}, 64 * 1024, error);
    }
    if (type == "replace") {
        return RequirePositions(value, {"positionByte", "deleteBytes"}, error)
            && RequireString(value, "insertBase64", kMaximumTextBytes, error);
    }
    if (type == "reservationTarget") {
        return RequireStrings(value, {"id", "displayName", "color"}, 1024, error);
    }
    if (type == "reservation") {
        return RequireStrings(value,
                {"id", "assigneeId", "assignee", "color", "createdById", "createdBy", "status", "comment"},
                64 * 1024, error)
            && RequirePositions(value, {"startByte", "endByte"}, error)
            && RequireInteger(value, "keyCount", 0, 1'000'000, error);
    }
    if (type == "commentThread") {
        return RequireStrings(value,
                {"id", "author", "color", "status", "summaryBase64", "summaryAuthor", "summaryColor", "threadBase64"},
                kMaximumTextBytes, error)
            && RequirePositions(value, {"startByte", "endByte"}, error)
            && RequireInteger(value, "messageCount", 0, 1'000'000, error);
    }
    if (type == "commentMessage" || type == "suggestionMessage") {
        return RequireStrings(value, {"id", "author", "color", "bodyBase64"}, kMaximumTextBytes, error);
    }
    if (type == "suggestion") {
        return RequireStrings(value,
                {"id", "author", "color", "decidedBy", "status", "originalBase64", "replacementBase64", "threadBase64"},
                kMaximumTextBytes, error)
            && RequirePositions(value, {"startByte", "endByte"}, error)
            && RequireInteger(value, "messageCount", 0, 1'000'000, error);
    }
    if (type == "presence") {
        return RequireStrings(value, {"clientId", "user", "color"}, 1024, error)
            && RequireInteger(value, "positionByte", 0, kMaximumPosition, error);
    }
    error = "unsupported protocol message type";
    return false;
}

}  // namespace

struct Message::Data {
    Json payload;
    std::string type;
};

std::optional<Message> Message::Parse(std::string_view input, std::string& error) {
    error.clear();
    if (input.empty() || input.size() > kMaximumTextBytes) {
        error = "JSON message is empty or exceeds the IPC limit";
        return std::nullopt;
    }
    Json value = Json::parse(input, nullptr, false, true);
    if (value.is_discarded() || !value.is_object()) {
        error = "protocol message must be one valid JSON object";
        return std::nullopt;
    }
    if (value.size() > kMaximumFields) {
        error = "protocol message contains too many fields";
        return std::nullopt;
    }
    if (!RequireString(value, "type", kMaximumTypeBytes, error, false)) return std::nullopt;
    const std::string type = value["type"].get<std::string>();
    if (!kKnownTypes.contains(type)) {
        error = "unknown protocol message type";
        return std::nullopt;
    }
    if (!ValidateSchema(value, type, error)) return std::nullopt;
    return Message(std::make_shared<Data>(Data{std::move(value), type}));
}

const std::string& Message::Type() const noexcept {
    return data_->type;
}

std::string Message::String(std::string_view key) const {
    const auto iterator = data_->payload.find(std::string(key));
    return iterator != data_->payload.end() && iterator->is_string() ? iterator->get<std::string>() : std::string{};
}

std::int64_t Message::Integer(std::string_view key, std::int64_t fallback) const noexcept {
    try {
        const auto iterator = data_->payload.find(std::string(key));
        return iterator != data_->payload.end() && iterator->is_number_integer()
            ? iterator->get<std::int64_t>()
            : fallback;
    } catch (const Json::exception&) {
        return fallback;
    }
}

std::string EscapeString(std::string_view value) {
    const std::string encoded = Json(value).dump();
    return encoded.substr(1, encoded.size() - 2);
}

}  // namespace eaw::protocol
