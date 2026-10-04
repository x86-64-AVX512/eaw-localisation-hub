import { initialiseUiLanguage } from './ui-language.ts';

// Resolve language before modules construct static tutorials, labels and menus.
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
await initialiseUiLanguage(token);
const params = new URLSearchParams(location.hash.slice(1));
if (window.parent === window && !params.get('readOnly')) {
  const { createWorkspaceWindow } = await import('./workspace-window.ts');
  createWorkspaceWindow();
} else await import('./app.ts');
