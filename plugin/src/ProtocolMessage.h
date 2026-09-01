#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace eaw::protocol {

class Message final {
public:
    static std::optional<Message> Parse(std::string_view input, std::string& error);

    const std::string& Type() const noexcept;
    std::string String(std::string_view key) const;
    std::int64_t Integer(std::string_view key, std::int64_t fallback = 0) const noexcept;

private:
    struct Data;
    explicit Message(std::shared_ptr<const Data> data) : data_(std::move(data)) {}
    std::shared_ptr<const Data> data_;
};

std::string EscapeString(std::string_view value);

}  // namespace eaw::protocol
