import { initialiseUiLanguage } from './ui-language.ts';
import { readLaunchToken } from './launch-session.ts';

// Resolve language before modules construct static tutorials, labels and menus.
const params = new URLSearchParams(location.hash.slice(1));
await initialiseUiLanguage(readLaunchToken(params));
if (window.parent === window && !(params.get('readOnly') ?? params.get('readonly'))) {
  const { createWorkspaceWindow } = await import('./workspace-window.ts');
  createWorkspaceWindow();
} else await import('./app.ts');
