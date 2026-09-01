#pragma once

#include <windows.h>

#include <string>

namespace eaw::plugin {

struct PresenceEntry {
    std::string clientId;
    std::string user;
    std::string color;
    LRESULT position{};
    LRESULT anchor{};
};

struct PresenceOverlayHit {
    std::string clientId;
    RECT caret{};
    RECT label{};
    bool hasLabel{};
};

struct ReservationEntry {
    std::string id;
    std::string assigneeId;
    std::string assignee;
    std::string color;
    std::string createdById;
    std::string createdBy;
    std::string status;
    std::string comment;
    LRESULT start{};
    LRESULT end{};
    long long keyCount{};
};

struct ReservationTargetEntry {
    std::string id;
    std::string displayName;
    std::string color;
};

struct ExternalConflictEntry {
    std::string key;
    std::string label;
    std::string detail;
    std::string source;
};

struct CommentEntry {
    std::string id;
    std::string author;
    std::string color;
    std::string status;
    std::string summary;
    std::string summaryAuthor;
    std::string summaryColor;
    std::string thread;
    LRESULT start{};
    LRESULT end{};
    long long messageCount{};
};

struct DiscussionEntry {
    std::string author;
    std::string color;
    std::string body;
};

struct SuggestionEntry {
    std::string id;
    std::string author;
    std::string color;
    std::string decidedBy;
    std::string status;
    std::string original;
    std::string replacement;
    std::string thread;
    LRESULT start{};
    LRESULT end{};
    long long messageCount{};
};

enum class SuggestionDisplayMode {
    Review,
    Compact,
    Hidden,
};

struct SuggestionOverlayHit {
    std::string id;
    RECT card{};
};

struct TextInputContext {
    std::wstring title;
    std::wstring label;
    std::wstring value;
    size_t maximumCharacters{};
    bool accepted{};
};

}  // namespace eaw::plugin
