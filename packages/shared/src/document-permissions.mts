/** Additive account permissions; document contents never determine access. */
export interface DocumentActor { roles?: readonly string[]; id?: string; }
const TRANSLATION_ROLES = new Set(['admin', 'senior translator', 'translator', 'trainee-translator', 'translation-editor']);
export function isModContributorOnly(actor: DocumentActor | null | undefined): boolean {
  return Boolean(actor?.roles?.includes('mod-contributor') && !actor.roles.some((role) => TRANSLATION_ROLES.has(role)));
}
export function isEnglishDocument(documentIdOrPath: string): boolean {
  const value = String(documentIdOrPath).replaceAll('\\', '/');
  const relative = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return /^localisation\/(?:replace\/)?english\/.+\.ya?ml$/iu.test(relative)
    && !relative.split('/').some((part) => !part || part === '.' || part === '..');
}
export function canEditDocument(actor: DocumentActor | null | undefined, documentIdOrPath: string): boolean {
  return !isModContributorOnly(actor) || isEnglishDocument(documentIdOrPath);
}
export function canDecideSuggestions(actor: DocumentActor | null | undefined): boolean {
  return !isModContributorOnly(actor);
}
const DISCUSSION_CONTROLS = new Set(['presence', 'history-get', 'personal-projection-get', 'disk-merge-check', 'sync-flush',
  'comment-create', 'comment-reply', 'suggestion-reply']);
const DECISION_CONTROLS = new Set(['suggestion-accept', 'suggestion-reject', 'suggestion-revert']);
export function documentControlAllowed(actor: DocumentActor | null | undefined, documentId: string, type: string): boolean {
  if (!isModContributorOnly(actor)) return true;
  if (DISCUSSION_CONTROLS.has(type)) return true;
  if (DECISION_CONTROLS.has(type)) return false;
  return canEditDocument(actor, documentId);
}
export function requireDocumentEdit(actor: DocumentActor | null | undefined, documentId: string): void {
  if (!canEditDocument(actor, documentId)) throw new Error('Mod contributors may edit English localisation files only');
}
export function requireDocumentControl(actor: DocumentActor | null | undefined, documentId: string, type: string): void {
  if (!documentControlAllowed(actor, documentId, type)) {
    throw new Error(DECISION_CONTROLS.has(type) ? 'A translation role is required to decide suggestions'
      : 'Mod contributors may edit English localisation files only');
  }
}
