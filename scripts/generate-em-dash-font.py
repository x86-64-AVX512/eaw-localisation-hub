"""Print the CSS for Review's original, single-glyph U+2014 font.

Requires fontTools only when regenerating; no external font is modified/copied.
The shipped CSS is self-contained and needs no font tool at build/runtime.
"""
import base64
import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder([".notdef", "emdash"])
empty = TTGlyphPen(None)
dash = TTGlyphPen(None)
dash.moveTo((50, 290))
dash.lineTo((950, 290))
dash.lineTo((950, 350))
dash.lineTo((50, 350))
dash.closePath()
builder.setupGlyf({".notdef": empty.glyph(), "emdash": dash.glyph()})
builder.setupHorizontalMetrics({".notdef": (1000, 0), "emdash": (1000, 50)})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupCharacterMap({0x2014: "emdash"})
builder.setupNameTable({"familyName": "EaW Em Dash", "styleName": "Regular",
                       "uniqueFontIdentifier": "EaWEmDash-Regular-v1",
                       "fullName": "EaW Em Dash Regular", "psName": "EaWEmDash-Regular",
                       "version": "Version 1.0"})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.font["head"].created = builder.font["head"].modified = 0
output = io.BytesIO()
builder.save(output)
encoded = base64.b64encode(output.getvalue()).decode("ascii")
print('/* Original U+2014-only glyph; regenerate with scripts/generate-em-dash-font.py. */')
print('@font-face {\n  font-family: "EaW Em Dash";')
print(f'  src: url("data:font/ttf;base64,{encoded}") format("truetype");')
print('  unicode-range: U+2014;\n  font-style: normal;\n  font-weight: 100 900;\n}')
