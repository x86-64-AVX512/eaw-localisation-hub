import englishMessages from '../locales/en.json' with { type: 'json' };

export type UiLanguage = 'ru' | 'en';
export type UiLanguagePreference = UiLanguage | 'auto';
let language: UiLanguage = 'ru';
const catalog: Readonly<Record<string, string>> = englishMessages;

export function resolveUiLanguage(preference: unknown, windowsUiCulture: unknown): UiLanguage {
  if (preference === 'ru' || preference === 'en') return preference;
  return /^ru(?:-|$)/iu.test(String(windowsUiCulture ?? '')) ? 'ru' : 'en';
}
export function setUiLanguage(value: UiLanguage): void { language = value; }
export function getUiLanguage(): UiLanguage { return language; }
export function uiLocale(): string { return language === 'ru' ? 'ru-RU' : 'en-GB'; }

// Translate only developer-authored messages. Values are interpolated afterwards
// and are never inspected or translated (keys, filenames, comments and YAML).
export function uiText(source: string, ...values: unknown[]): string {
  const text = language === 'en' ? catalog[source] ?? source : source;
  return text.replace(/\{(\d+)\}/gu, (token, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : token);
}

export function hasEnglishMessage(source: string): boolean { return Object.hasOwn(catalog, source); }

function messagePattern(source: string): RegExp | null {
  if (!/\{\d+\}/u.test(source)) return null;
  let pattern = '', end = 0;
  for (const match of source.matchAll(/\{\d+\}/gu)) {
    pattern += source.slice(end, match.index).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '([\\s\\S]*?)';
    end = match.index + match[0].length;
  }
  pattern += source.slice(end).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${pattern}$`, 'u');
}
const systemPatterns = Object.entries(catalog).map(([source, translation]) => ({
  source, translation, pattern: messagePattern(source),
  indices: [...source.matchAll(/\{(\d+)\}/gu)].map((match) => Number(match[1])),
})).filter((item) => item.pattern).sort((a, b) =>
  b.source.replace(/\{\d+\}/gu, '').length - a.source.replace(/\{\d+\}/gu, '').length);

/** Legacy Agent diagnostics only. Never use for document or discussion text. */
export function uiMessage(message: string): string {
  if (language !== 'en') return message;
  if (Object.hasOwn(catalog, message)) return catalog[message];
  for (const { pattern, translation, indices } of systemPatterns) {
    const matched = pattern!.exec(message);
    if (!matched) continue;
    const values = new Map(indices.map((index, order) => [index, matched[order + 1]]));
    return translation.replace(/\{(\d+)\}/gu, (token, index: string) => values.get(Number(index)) ?? token);
  }
  return message;
}
