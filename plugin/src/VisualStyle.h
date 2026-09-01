#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <string_view>

namespace eaw::visual {

COLORREF ColorFromString(std::string_view value, COLORREF fallback = RGB(106, 169, 255));
bool RectanglesOverlap(const RECT& left, const RECT& right);
COLORREF ReadableAnnotationColor(COLORREF color);

}  // namespace eaw::visual
