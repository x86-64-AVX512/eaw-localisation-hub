#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "CollaborationOverlays.h"

#include <algorithm>

#include "EditorInterop.h"
#include "VisualStyle.h"

namespace eaw::overlays {
namespace {

bool Contains(const std::vector<std::string>& ids, const std::string& id) {
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

}  // namespace

void Invalidate(const NppData& nppData) {
    if (nppData._scintillaMainHandle) InvalidateRect(nppData._scintillaMainHandle, nullptr, FALSE);
    if (nppData._scintillaSecondHandle) InvalidateRect(nppData._scintillaSecondHandle, nullptr, FALSE);
}

void ClearPresenceHover(const NppData& nppData, std::vector<std::string>& hoveredIds) {
    if (hoveredIds.empty()) return;
    hoveredIds.clear();
    Invalidate(nppData);
}

void UpdatePresenceHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::PresenceOverlayHit>& hits,
    std::vector<std::string>& hoveredIds) {
    if (scintilla != currentScintilla) return;
    std::vector<std::string> hovered;
    for (const auto& hit : hits) {
        if (PtInRect(&hit.caret, point)) hovered.push_back(hit.clientId);
    }
    if (hovered.empty()) {
        for (const auto& hit : hits) {
            if (hit.hasLabel && Contains(hoveredIds, hit.clientId) && PtInRect(&hit.label, point)) {
                hovered.push_back(hit.clientId);
            }
        }
    }
    std::sort(hovered.begin(), hovered.end());
    hovered.erase(std::unique(hovered.begin(), hovered.end()), hovered.end());
    auto previous = hoveredIds;
    std::sort(previous.begin(), previous.end());
    if (hovered == previous) return;
    hoveredIds = std::move(hovered);
    InvalidateRect(scintilla, nullptr, FALSE);
}

void DrawPresences(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::PresenceEntry>& presences,
    std::vector<plugin::PresenceOverlayHit>& hits,
    const std::vector<std::string>& hoveredIds) {
    if (scintilla != currentScintilla) return;
    hits.clear();
    if (presences.empty()) return;

    RECT client{};
    GetClientRect(scintilla, &client);
    if (client.right <= client.left || client.bottom <= client.top) return;
    const int clientLeft = static_cast<int>(client.left);
    const int clientTop = static_cast<int>(client.top);
    const int clientRight = static_cast<int>(client.right);
    const int clientBottom = static_cast<int>(client.bottom);
    HDC device = GetDC(scintilla);
    if (!device) return;
    const HGDIOBJ previousFont = SelectObject(device, GetStockObject(DEFAULT_GUI_FONT));
    SetBkMode(device, TRANSPARENT);
    TEXTMETRICW metrics{};
    GetTextMetricsW(device, &metrics);
    const int labelHeight = std::max(17, static_cast<int>(metrics.tmHeight) + 6);
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    std::vector<RECT> occupiedLabels;
    std::vector<LRESULT> occupiedPositions;

    for (const auto& presence : presences) {
        const LRESULT position = std::clamp<LRESULT>(presence.position, 0, documentLength);
        const LRESULT line = SendMessage(scintilla, SCI_LINEFROMPOSITION, position, 0);
        const int lineHeight = std::max<int>(12, static_cast<int>(SendMessage(scintilla, SCI_TEXTHEIGHT, line, 0)));
        int x = static_cast<int>(SendMessage(scintilla, SCI_POINTXFROMPOSITION, 0, position));
        const int y = static_cast<int>(SendMessage(scintilla, SCI_POINTYFROMPOSITION, 0, position));
        if (y + lineHeight <= clientTop || y >= clientBottom) continue;
        const int samePositionCount = static_cast<int>(std::count(occupiedPositions.begin(), occupiedPositions.end(), position));
        occupiedPositions.push_back(position);
        x = std::clamp(x + samePositionCount * 2, clientLeft, std::max(clientLeft, clientRight - 2));

        const COLORREF color = visual::ColorFromString(presence.color, RGB(255, 145, 55));
        HBRUSH brush = CreateSolidBrush(color);
        RECT caretRect{x, std::max(clientTop, y), x + 2, std::min(clientBottom, y + lineHeight)};
        FillRect(device, &caretRect, brush);
        RECT caretHit = caretRect;
        InflateRect(&caretHit, 5, 3);
        IntersectRect(&caretHit, &caretHit, &client);
        plugin::PresenceOverlayHit hit{presence.clientId, caretHit, {}, false};
        if (!Contains(hoveredIds, presence.clientId)) {
            hits.push_back(std::move(hit));
            DeleteObject(brush);
            continue;
        }

        std::wstring label = editor::Utf8ToWide(presence.user.empty() ? presence.clientId : presence.user);
        if (label.size() > 80) label.resize(80);
        SIZE measured{};
        GetTextExtentPoint32W(device, label.c_str(), static_cast<int>(label.size()), &measured);
        const int labelWidth = std::clamp(static_cast<int>(measured.cx) + 10, 42, 220);
        const int labelLeft = std::clamp(x + 3, clientLeft, std::max(clientLeft, clientRight - labelWidth));
        RECT labelRect{};
        bool placed = false;
        for (int tier = 1; tier <= 32 && !placed; ++tier) {
            const int top = y - tier * (labelHeight + 2) + 2;
            RECT candidate{labelLeft, top, labelLeft + labelWidth, top + labelHeight};
            const bool collision = std::any_of(occupiedLabels.begin(), occupiedLabels.end(),
                [&](const RECT& other) { return visual::RectanglesOverlap(candidate, other); });
            if (!collision && candidate.top >= clientTop && candidate.bottom <= clientBottom) {
                labelRect = candidate;
                placed = true;
            }
        }
        for (int tier = 0; tier <= 32 && !placed; ++tier) {
            const int top = y + lineHeight + tier * (labelHeight + 2);
            RECT candidate{labelLeft, top, labelLeft + labelWidth, top + labelHeight};
            const bool collision = std::any_of(occupiedLabels.begin(), occupiedLabels.end(),
                [&](const RECT& other) { return visual::RectanglesOverlap(candidate, other); });
            if (!collision && candidate.top >= clientTop && candidate.bottom <= clientBottom) {
                labelRect = candidate;
                placed = true;
            }
        }
        if (!placed) {
            hits.push_back(std::move(hit));
            DeleteObject(brush);
            continue;
        }
        occupiedLabels.push_back(labelRect);
        hit.label = labelRect;
        hit.hasLabel = true;
        hits.push_back(std::move(hit));
        HPEN pen = CreatePen(PS_SOLID, 1, color);
        const HGDIOBJ previousPen = SelectObject(device, pen);
        const HGDIOBJ previousBrush = SelectObject(device, brush);
        RoundRect(device, labelRect.left, labelRect.top, labelRect.right, labelRect.bottom, 4, 4);
        SelectObject(device, previousBrush);
        SelectObject(device, previousPen);
        DeleteObject(pen);
        const int luminance = GetRValue(color) * 299 + GetGValue(color) * 587 + GetBValue(color) * 114;
        SetTextColor(device, luminance >= 150000 ? RGB(25, 25, 25) : RGB(255, 255, 255));
        RECT textRect = labelRect;
        textRect.left += 5;
        textRect.right -= 5;
        DrawTextW(device, label.c_str(), static_cast<int>(label.size()), &textRect,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
        DeleteObject(brush);
    }
    SelectObject(device, previousFont);
    ReleaseDC(scintilla, device);
}

void UpdateSuggestionHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::SuggestionOverlayHit>& hits,
    std::vector<std::string>& hoveredIds) {
    if (scintilla != currentScintilla) return;
    std::vector<std::string> hovered;
    for (const auto& hit : hits) {
        if (PtInRect(&hit.card, point)) hovered.push_back(hit.id);
    }
    std::sort(hovered.begin(), hovered.end());
    auto previous = hoveredIds;
    std::sort(previous.begin(), previous.end());
    if (hovered == previous) return;
    hoveredIds = std::move(hovered);
    InvalidateRect(scintilla, nullptr, FALSE);
}

void ClearSuggestionHover(const NppData& nppData, std::vector<std::string>& hoveredIds) {
    if (hoveredIds.empty()) return;
    hoveredIds.clear();
    Invalidate(nppData);
}

void DrawSuggestionGhosts(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::SuggestionEntry>& suggestions,
    plugin::SuggestionDisplayMode mode,
    std::vector<plugin::SuggestionOverlayHit>& hits,
    const std::vector<std::string>& hoveredIds) {
    hits.clear();
    if (scintilla != currentScintilla || suggestions.empty()
        || mode == plugin::SuggestionDisplayMode::Hidden) return;
    RECT client{};
    GetClientRect(scintilla, &client);
    if (client.right <= client.left || client.bottom <= client.top) return;
    HDC device = GetDC(scintilla);
    if (!device) return;
    const HGDIOBJ previousFont = SelectObject(device, GetStockObject(DEFAULT_GUI_FONT));
    SetBkMode(device, TRANSPARENT);
    TEXTMETRICW metrics{};
    GetTextMetricsW(device, &metrics);
    const int compactHeight = std::max(18, static_cast<int>(metrics.tmHeight) + 6);
    const int reviewHeight = std::max(45, static_cast<int>(metrics.tmHeight) * 2 + 12);
    const LRESULT documentLength = SendMessage(scintilla, SCI_GETLENGTH, 0, 0);
    std::vector<RECT> occupied;
    size_t visibleReviewCards = 0;

    for (const auto& suggestion : suggestions) {
        if (suggestion.status != "open" && suggestion.status != "stale") continue;
        const LRESULT start = std::clamp<LRESULT>(suggestion.start, 0, documentLength);
        const LRESULT end = std::clamp<LRESULT>(suggestion.end, start, documentLength);
        const LRESULT line = SendMessage(scintilla, SCI_LINEFROMPOSITION, start, 0);
        const LRESULT lineEnd = SendMessage(scintilla, SCI_GETLINEENDPOSITION, line, 0);
        const int lineHeight = std::max<int>(12, static_cast<int>(SendMessage(scintilla, SCI_TEXTHEIGHT, line, 0)));
        const int x = static_cast<int>(SendMessage(scintilla, SCI_POINTXFROMPOSITION, 0, end));
        const int y = static_cast<int>(SendMessage(scintilla, SCI_POINTYFROMPOSITION, 0, start));
        if (x < client.left || x > client.right || y + lineHeight < client.top || y > client.bottom) continue;

        std::string replacement = suggestion.replacement.empty() ? "[удалить]" : suggestion.replacement;
        std::replace(replacement.begin(), replacement.end(), '\r', ' ');
        std::replace(replacement.begin(), replacement.end(), '\n', ' ');
        std::string original = suggestion.original;
        std::replace(original.begin(), original.end(), '\r', ' ');
        std::replace(original.begin(), original.end(), '\n', ' ');
        const bool hovered = Contains(hoveredIds, suggestion.id);
        const bool review = mode == plugin::SuggestionDisplayMode::Review;
        if (review && visibleReviewCards >= 8) continue;
        std::wstring label = L"→ " + editor::Utf8ToWide(replacement);
        if (suggestion.status == "stale") label += L" · устарело";
        const size_t compactLimit = hovered ? 240 : 90;
        if (label.size() > compactLimit) label = label.substr(0, compactLimit - 1) + L"…";
        SIZE measured{};
        GetTextExtentPoint32W(device, label.c_str(), static_cast<int>(label.size()), &measured);
        const int maximumWidth = std::max(120, static_cast<int>(client.right - client.left) - 20);
        const int width = review
            ? std::clamp(maximumWidth / 3, 210, 340)
            : std::clamp(static_cast<int>(measured.cx) + 12, 44, std::min(520, maximumWidth));
        const int left = review
            ? std::max(static_cast<int>(client.left) + 8, static_cast<int>(client.right) - width - 8)
            : std::clamp(x + 4, static_cast<int>(client.left),
                std::max(static_cast<int>(client.left), static_cast<int>(client.right) - width));
        const int cardHeight = review ? reviewHeight : compactHeight;
        int top = review ? y : (end >= lineEnd ? y : y - compactHeight - 2);
        if (top < client.top) top = y + lineHeight + 2;
        RECT card{left, top, left + width, top + cardHeight};
        while (std::any_of(occupied.begin(), occupied.end(),
            [&](const RECT& other) { return visual::RectanglesOverlap(card, other); })) {
            OffsetRect(&card, 0, cardHeight + 3);
        }
        if (card.bottom > client.bottom) continue;
        occupied.push_back(card);
        if (review) ++visibleReviewCards;
        hits.push_back({suggestion.id, card});

        const COLORREF color = visual::ColorFromString(suggestion.color, RGB(50, 175, 100));
        if (review) {
            HPEN connector = CreatePen(PS_SOLID, 1, color);
            const HGDIOBJ previousConnector = SelectObject(device, connector);
            MoveToEx(device, std::min(x + 3, static_cast<int>(card.left)), y + lineHeight / 2, nullptr);
            LineTo(device, card.left, card.top + cardHeight / 2);
            SelectObject(device, previousConnector);
            DeleteObject(connector);
        }
        HBRUSH background = CreateSolidBrush(GetSysColor(COLOR_WINDOW));
        HPEN border = CreatePen(PS_SOLID, 1, color);
        const HGDIOBJ previousBrush = SelectObject(device, background);
        const HGDIOBJ previousPen = SelectObject(device, border);
        RoundRect(device, card.left, card.top, card.right, card.bottom, 5, 5);
        SelectObject(device, previousBrush);
        SelectObject(device, previousPen);
        DeleteObject(background);
        DeleteObject(border);
        SetTextColor(device, visual::ReadableAnnotationColor(color));
        if (review) {
            std::wstring title = editor::Utf8ToWide(
                suggestion.author.empty() ? "Неизвестно" : suggestion.author);
            title += suggestion.status == "stale" ? L" · устарело" : L" · предлагает";
            RECT titleRect{card.left + 7, card.top + 3, card.right - 6, card.top + compactHeight + 1};
            DrawTextW(device, title.c_str(), static_cast<int>(title.size()), &titleRect,
                DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
            std::wstring comparison = editor::Utf8ToWide(original) + L" → " + editor::Utf8ToWide(replacement);
            if (!hovered && comparison.size() > 120) comparison = comparison.substr(0, 119) + L"…";
            RECT bodyRect{card.left + 7, card.top + compactHeight + 1, card.right - 6, card.bottom - 3};
            DrawTextW(device, comparison.c_str(), static_cast<int>(comparison.size()), &bodyRect,
                DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
        } else {
            RECT textRect = card;
            textRect.left += 6;
            textRect.right -= 6;
            DrawTextW(device, label.c_str(), static_cast<int>(label.size()), &textRect,
                DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
        }
    }
    SelectObject(device, previousFont);
    ReleaseDC(scintilla, device);
}

void ClearReservationHover(const NppData& nppData, std::vector<std::string>& hoveredIds, bool& labelVisible) {
    if (hoveredIds.empty() && !labelVisible) return;
    hoveredIds.clear();
    labelVisible = false;
    Invalidate(nppData);
}

void UpdateReservationHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::ReservationEntry>& reservations,
    std::vector<std::string>& hoveredIds,
    POINT& hoverPoint,
    const RECT& label,
    bool& labelVisible) {
    if (scintilla != currentScintilla) return;
    if (labelVisible && PtInRect(&label, point)) {
        hoverPoint = point;
        return;
    }
    const LRESULT position = SendMessage(scintilla, SCI_POSITIONFROMPOINTCLOSE, point.x, point.y);
    std::vector<std::string> hovered;
    if (position >= 0) {
        for (const auto& reservation : reservations) {
            if (reservation.status == "orphaned") continue;
            const LRESULT start = std::min(reservation.start, reservation.end);
            const LRESULT end = std::max(start + 1, std::max(reservation.start, reservation.end));
            if (position >= start && position < end) hovered.push_back(reservation.id);
        }
    }
    std::sort(hovered.begin(), hovered.end());
    auto previous = hoveredIds;
    std::sort(previous.begin(), previous.end());
    hoverPoint = point;
    if (hovered == previous) return;
    hoveredIds = std::move(hovered);
    labelVisible = false;
    InvalidateRect(scintilla, nullptr, FALSE);
}

void DrawReservationHover(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::ReservationEntry>& reservations,
    const std::vector<std::string>& hoveredIds,
    const POINT& hoverPoint,
    RECT& label,
    bool& labelVisible) {
    if (scintilla != currentScintilla || hoveredIds.empty()) {
        labelVisible = false;
        return;
    }
    std::vector<const plugin::ReservationEntry*> hovered;
    for (const auto& reservation : reservations) {
        if (Contains(hoveredIds, reservation.id)) hovered.push_back(&reservation);
    }
    if (hovered.empty()) {
        labelVisible = false;
        return;
    }
    RECT client{};
    GetClientRect(scintilla, &client);
    HDC device = GetDC(scintilla);
    if (!device) return;
    const HGDIOBJ previousFont = SelectObject(device, GetStockObject(DEFAULT_GUI_FONT));
    SetBkMode(device, TRANSPARENT);
    TEXTMETRICW metrics{};
    GetTextMetricsW(device, &metrics);
    const int rowHeight = std::max(19, static_cast<int>(metrics.tmHeight) + 7);
    int width = 90;
    std::vector<std::wstring> labels;
    for (const auto* reservation : hovered) {
        std::wstring text = L"Бронь: " + editor::Utf8ToWide(reservation->assignee.empty() ? "Unknown" : reservation->assignee);
        if (!reservation->createdBy.empty() && reservation->createdBy != reservation->assignee) {
            text += L" · создал: " + editor::Utf8ToWide(reservation->createdBy);
        }
        if (text.size() > 140) text.resize(140);
        SIZE measured{};
        GetTextExtentPoint32W(device, text.c_str(), static_cast<int>(text.size()), &measured);
        width = std::max(width, static_cast<int>(measured.cx) + 30);
        labels.push_back(std::move(text));
    }
    width = std::min(width, 420);
    const int height = rowHeight * static_cast<int>(labels.size()) + 4;
    int left = hoverPoint.x + 14;
    int top = hoverPoint.y + 18;
    if (left + width > client.right) left = std::max<int>(client.left, hoverPoint.x - width - 8);
    if (top + height > client.bottom) top = std::max<int>(client.top, hoverPoint.y - height - 8);
    RECT labelRect{left, top, left + width, top + height};
    HBRUSH background = CreateSolidBrush(GetSysColor(COLOR_INFOBK));
    HPEN border = CreatePen(PS_SOLID, 1, GetSysColor(COLOR_INFOTEXT));
    const HGDIOBJ previousBrush = SelectObject(device, background);
    const HGDIOBJ previousPen = SelectObject(device, border);
    RoundRect(device, labelRect.left, labelRect.top, labelRect.right, labelRect.bottom, 5, 5);
    SelectObject(device, previousBrush);
    SelectObject(device, previousPen);
    DeleteObject(background);
    DeleteObject(border);
    SetTextColor(device, GetSysColor(COLOR_INFOTEXT));
    for (size_t index = 0; index < labels.size(); ++index) {
        const int rowTop = labelRect.top + 2 + static_cast<int>(index) * rowHeight;
        RECT swatch{labelRect.left + 7, rowTop + (rowHeight - 10) / 2,
            labelRect.left + 17, rowTop + (rowHeight - 10) / 2 + 10};
        HBRUSH colour = CreateSolidBrush(visual::ColorFromString(hovered[index]->color));
        FillRect(device, &swatch, colour);
        DeleteObject(colour);
        RECT textRect{labelRect.left + 23, rowTop, labelRect.right - 6, rowTop + rowHeight};
        DrawTextW(device, labels[index].c_str(), static_cast<int>(labels[index].size()), &textRect,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
    }
    label = labelRect;
    labelVisible = true;
    SelectObject(device, previousFont);
    ReleaseDC(scintilla, device);
}

}  // namespace eaw::overlays
