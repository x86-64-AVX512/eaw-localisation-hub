import { technicalInsertions } from './localisation-markup.mts';

export type ReplacementLanguage = 'russian' | 'english';
export type ReplacementMode = 'classic' | 'language-filtered';
export interface ReplacementLanguageProfile {
  language: ReplacementLanguage | 'neutral';
  cyrillicPercent: number;
  latinPercent: number;
}
export interface IgnoredReplacementEntry extends ReplacementLanguageProfile {
  key: string;
  line: number;
  reason: 'language' | 'original-section';
}

// Count visible letters, not identifiers in references, getters, icons or colour
// codes. This is a script heuristic, not a dictionary or a language guarantee.
export function replacementLanguageProfile(value: string): ReplacementLanguageProfile {
  let visible = '', offset = 0;
  for (const token of technicalInsertions(value)) {
    visible += value.slice(offset, token.start);
    offset = token.end;
  }
  visible += value.slice(offset);
  visible = visible.replace(/§[^\r\n]|\\./gu, '');
  let cyrillic = 0, latin = 0;
  for (const character of visible) {
    if (!/\p{L}/u.test(character)) continue;
    if (/\p{Script=Cyrillic}/u.test(character)) cyrillic += 1;
    else if (/\p{Script=Latin}/u.test(character)) latin += 1;
  }
  const total = cyrillic + latin;
  const cyrillicPercent = total ? Math.round(cyrillic / total * 1000) / 10 : 0;
  return {
    language: cyrillic === latin ? 'neutral' : cyrillic > latin ? 'russian' : 'english',
    cyrillicPercent,
    latinPercent: total ? Math.round((100 - cyrillicPercent) * 10) / 10 : 0,
  };
}

// These headings describe the user's English-original/Russian-translation
// review template. They label skipped originals, never override the script test
// or suppress duplicate Russian/neutral values. Other comments don't change it.
export function russianReviewSection(line: string): 'original' | 'translation' | null {
  if (/^\s*#\s*(?:Оригинал|Original)\s*:?\s*$/iu.test(line)) return 'original';
  if (/^\s*#\s*(?:Перевод|Translation)\s*:?\s*$/iu.test(line)) return 'translation';
  return null;
}
