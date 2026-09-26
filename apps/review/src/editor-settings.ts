import { requiredElement } from './dom-elements.ts';

const STORAGE_KEY = 'eaw-hub-editor-settings-v1';
interface EditorSettings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

interface EditorThemeDefinition {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: { token: string; foreground: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

interface EditorSettingsOptions {
  monaco: { editor: {
    defineTheme(name: string, definition: EditorThemeDefinition): void;
    setTheme(name: string): void;
  } };
  editor: { updateOptions(options: { fontFamily: string; fontSize: number; lineHeight: number }): void };
  showToast(message: string): void;
}

const DEFAULTS: EditorSettings = { theme: 'dark', fontFamily: 'Consolas', fontSize: 15, lineHeight: 23 };
const EDITOR_THEMES: Record<string, EditorThemeDefinition> = {
  dark: { base: 'vs-dark', inherit: true, rules: [], colors: {} },
  light: { base: 'vs', inherit: true, rules: [], colors: {} },
  contrast: { base: 'hc-black', inherit: true, rules: [], colors: {} },
  midnight: {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: '7DD3FC', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '5EEAD4' },
      { token: 'number', foreground: 'C4B5FD' },
      { token: 'string', foreground: 'FDBA74' },
      { token: 'comment', foreground: '7186A3', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#08111F', 'editor.foreground': '#E6EDF7',
      'editor.lineHighlightBackground': '#12233A', 'editor.selectionBackground': '#285EA880',
      'editorCursor.foreground': '#70A5FF', 'editorLineNumber.foreground': '#607795',
    },
  },
  plum: {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: 'E9A8FF', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '8FE3D5' },
      { token: 'number', foreground: 'FFB4D0' },
      { token: 'string', foreground: 'F4B184' },
      { token: 'comment', foreground: '9B819F', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#17101D', 'editor.foreground': '#F1E9F4',
      'editor.lineHighlightBackground': '#281B31', 'editor.selectionBackground': '#804D9180',
      'editorCursor.foreground': '#E9A8FF', 'editorLineNumber.foreground': '#876F8E',
    },
  },
  forest: {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: '9ADBB7', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '6FD6C5' },
      { token: 'number', foreground: 'D7C77A' },
      { token: 'string', foreground: 'E7B978' },
      { token: 'comment', foreground: '758F80', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#0D1814', 'editor.foreground': '#E5EFE9',
      'editor.lineHighlightBackground': '#17271F', 'editor.selectionBackground': '#34735680',
      'editorCursor.foreground': '#8DE0B0', 'editorLineNumber.foreground': '#627A6A',
    },
  },
  sepia: {
    base: 'vs', inherit: true,
    rules: [
      { token: 'keyword', foreground: '7B4F27', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '1F6B62' },
      { token: 'number', foreground: '79528C' },
      { token: 'string', foreground: 'A34F2A' },
      { token: 'comment', foreground: '897866', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#F4ECDD', 'editor.foreground': '#3A3025',
      'editor.lineHighlightBackground': '#E9DCC6', 'editor.selectionBackground': '#C9975C70',
      'editorCursor.foreground': '#8F5F32', 'editorLineNumber.foreground': '#99866F',
    },
  },
};
const THEME_IDS = new Set(Object.keys(EDITOR_THEMES));

function loadSettings(): EditorSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<EditorSettings> }; }
  catch { return { ...DEFAULTS }; }
}

export function createEditorSettings({ monaco, editor, showToast }: EditorSettingsOptions) {
  for (const [name, definition] of Object.entries(EDITOR_THEMES)) {
    monaco.editor.defineTheme(`eaw-${name}`, definition);
  }
  const theme = requiredElement<HTMLSelectElement>('#editor-theme');
  const family = requiredElement<HTMLSelectElement>('#editor-font-family');
  const size = requiredElement<HTMLInputElement>('#editor-font-size');
  const lineHeight = requiredElement<HTMLInputElement>('#editor-line-height');
  let settings = loadSettings();

  function apply({ announce = false }: { announce?: boolean } = {}): void {
    settings = {
      theme: THEME_IDS.has(theme.value) ? theme.value : DEFAULTS.theme,
      fontFamily: family.value || DEFAULTS.fontFamily,
      fontSize: Math.max(12, Math.min(30, Number(size.value) || DEFAULTS.fontSize)),
      lineHeight: Math.max(18, Math.min(48, Number(lineHeight.value) || DEFAULTS.lineHeight)),
    };
    if (settings.lineHeight < settings.fontSize + 3) settings.lineHeight = settings.fontSize + 3;
    size.value = String(settings.fontSize); lineHeight.value = String(settings.lineHeight);
    document.documentElement.dataset.theme = settings.theme;
    monaco.editor.setTheme(`eaw-${settings.theme}`);
    editor.updateOptions({
      fontFamily: `${settings.fontFamily}, Consolas, monospace`,
      fontSize: settings.fontSize, lineHeight: settings.lineHeight,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    if (announce) showToast('Настройки редактора сохранены на этом компьютере.');
  }

  theme.value = settings.theme; family.value = settings.fontFamily;
  size.value = String(settings.fontSize); lineHeight.value = String(settings.lineHeight);
  for (const control of [theme, family, size, lineHeight]) {
    control.addEventListener('change', () => apply({ announce: true }));
  }
  apply();
  return { settings: () => ({ ...settings }) };
}
