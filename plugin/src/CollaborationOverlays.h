#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <string>
#include <vector>

#include "PluginInterface.h"
#include "PluginModel.h"

namespace eaw::overlays {

void Invalidate(const NppData& nppData);
void ClearPresenceHover(const NppData& nppData, std::vector<std::string>& hoveredIds);
void UpdatePresenceHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::PresenceOverlayHit>& hits,
    std::vector<std::string>& hoveredIds);
void DrawPresences(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::PresenceEntry>& presences,
    std::vector<plugin::PresenceOverlayHit>& hits,
    const std::vector<std::string>& hoveredIds);
void DrawSuggestionGhosts(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::SuggestionEntry>& suggestions,
    plugin::SuggestionDisplayMode mode,
    std::vector<plugin::SuggestionOverlayHit>& hits,
    const std::vector<std::string>& hoveredIds);
void UpdateSuggestionHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::SuggestionOverlayHit>& hits,
    std::vector<std::string>& hoveredIds);
void ClearSuggestionHover(const NppData& nppData, std::vector<std::string>& hoveredIds);

void ClearReservationHover(
    const NppData& nppData,
    std::vector<std::string>& hoveredIds,
    bool& labelVisible);
void UpdateReservationHover(
    HWND scintilla,
    HWND currentScintilla,
    POINT point,
    const std::vector<plugin::ReservationEntry>& reservations,
    std::vector<std::string>& hoveredIds,
    POINT& hoverPoint,
    const RECT& label,
    bool& labelVisible);
void DrawReservationHover(
    HWND scintilla,
    HWND currentScintilla,
    const std::vector<plugin::ReservationEntry>& reservations,
    const std::vector<std::string>& hoveredIds,
    const POINT& hoverPoint,
    RECT& label,
    bool& labelVisible);

}  // namespace eaw::overlays
