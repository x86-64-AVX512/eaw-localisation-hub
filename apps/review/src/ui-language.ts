import { setUiLanguage, uiText } from '../../../packages/shared/src/ui-language.mts';
import type { UiLanguage, UiLanguagePreference } from '../../../packages/shared/src/ui-language.mts';
import { embeddedSessionId, postWorkspace } from './workspace-bridge.ts';

interface LanguageSettings { language: UiLanguage; preference: UiLanguagePreference }

let initialisation: Promise<LanguageSettings> | undefined;
export function initialiseUiLanguage(token: string): Promise<LanguageSettings> {
  return initialisation ??= loadUiLanguage(token);
}

async function loadUiLanguage(token: string): Promise<LanguageSettings> {
  let settings: LanguageSettings = { language: 'en', preference: 'auto' };
  try {
    const response = await fetch('/api/ui-language', { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const value = await response.json() as LanguageSettings;
      if (value.language === 'ru' || value.language === 'en') settings = value;
    }
  } catch { /* The UI still opens with English while Agent reconnects. */ }
  setUiLanguage(settings.language);
  document.documentElement.lang = settings.language;
  // This runs once on the static HTML shell before any user data is inserted.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('script, style')) continue;
    const value = node.nodeValue ?? '', trimmed = value.trim();
    const contextualMessage = node.parentElement?.getAttribute('data-ui-message');
    if (trimmed) node.nodeValue = value.replace(trimmed, uiText(
      contextualMessage && settings.language === 'en' ? contextualMessage : trimmed));
  }
  for (const element of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, uiText(value));
    }
  }
  document.title = uiText(document.title);
  return settings;
}

export function createLanguageSelector(token: string, settings: LanguageSettings,
  beforeReload: () => Promise<void>, showToast: (text: string, isError?: boolean) => void): void {
  const selector = document.querySelector<HTMLSelectElement>('#ui-language');
  if (!selector) return;
  selector.value = settings.preference;
  selector.addEventListener('change', async () => {
    selector.disabled = true;
    try {
      const response = await fetch('/api/ui-language', { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ preference: selector.value }) });
      if (!response.ok) throw new Error(uiText('Не удалось сохранить язык интерфейса.'));
      if (embeddedSessionId()) { postWorkspace('reloadWorkspace'); return; }
      await beforeReload();
      window.location.reload();
    } catch (error) {
      selector.value = settings.preference;
      showToast(error instanceof Error ? error.message : String(error), true);
      selector.disabled = false;
    }
  });
}
