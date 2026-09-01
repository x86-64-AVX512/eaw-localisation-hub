#include "VisualStyle.h"

namespace eaw::visual {
namespace {

int HexDigit(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

}  // namespace

COLORREF ColorFromString(std::string_view value, COLORREF fallback) {
    if (value.size() != 7 || value[0] != '#') return fallback;
    int digits[6]{};
    for (size_t index = 0; index < 6; ++index) {
        digits[index] = HexDigit(value[index + 1]);
        if (digits[index] < 0) return fallback;
    }
    return RGB(
        digits[0] * 16 + digits[1],
        digits[2] * 16 + digits[3],
        digits[4] * 16 + digits[5]);
}

bool RectanglesOverlap(const RECT& left, const RECT& right) {
    return left.left < right.right
        && left.right > right.left
        && left.top < right.bottom
        && left.bottom > right.top;
}

COLORREF ReadableAnnotationColor(COLORREF color) {
    const int red = GetRValue(color);
    const int green = GetGValue(color);
    const int blue = GetBValue(color);
    const int luminance = (red * 299 + green * 587 + blue * 114) / 1000;
    if (luminance <= 205) return color;
    return RGB(red * 2 / 3, green * 2 / 3, blue * 2 / 3);
}

}  // namespace eaw::visual
