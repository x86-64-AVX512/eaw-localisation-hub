/** Presentation only: this font contains U+2014 and no other mapped glyphs. */
export function reviewFontFamily(family = 'Consolas'): string {
  return `"EaW Em Dash", ${family}, Consolas, monospace`;
}

export async function loadReviewDashFont(): Promise<void> {
  // Load before Monaco measures text; no late font swap under an existing cursor.
  try { await document.fonts.load('15px "EaW Em Dash"', '\u2014'); }
  catch { /* A font failure must not prevent opening the user's document. */ }
}
