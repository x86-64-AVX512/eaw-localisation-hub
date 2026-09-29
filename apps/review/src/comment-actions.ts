import type * as Monaco from 'monaco-editor';
import { encodeBase64 } from './review-utilities.ts';

interface CommentCommand { type: string; path: string; startByte: number; endByte: number;
  bodyBase64: string; reviewAnchors?: string; [field: string]: unknown }

export function createCommentActions({ monaco, editor, button, state, selectionBytes, askText,
  send, anchor = (message) => message, showToast }: {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  button: HTMLButtonElement;
  state: { path: string; ready: boolean; documentView: string };
  selectionBytes: () => { start: number; end: number };
  askText: (title: string, description: string) => Promise<string | null | undefined>;
  send: (message: CommentCommand) => void;
  anchor?: (message: CommentCommand) => CommentCommand;
  showToast: (text: string, error?: boolean) => void;
}) {
  let creating = false;
  const available = () => Boolean(state.path && state.ready && state.documentView === 'shared'
    && !button.disabled && !button.hidden && !editor.getOption(monaco.editor.EditorOption.readOnly));
  const context = editor.createContextKey<boolean>('eawCanCreateComment', false);
  const refresh = () => context.set(available() && !creating);

  async function create(): Promise<void> {
    if (creating || !available()) return;
    const model = editor.getModel();
    if (!model) return;
    const range = selectionBytes();
    const request = anchor({ type: 'commentCreate', path: state.path,
      startByte: range.start, endByte: range.end, bodyBase64: '' });
    const version = model.getVersionId();
    creating = true;
    refresh();
    try {
      const body = await askText('Новый комментарий', 'Комментарий к выделению или позиции курсора');
      if (!body?.trim()) return;
      if (!available() || state.path !== request.path || model !== editor.getModel()
        || (!request.reviewAnchors && model.getVersionId() !== version)) {
        showToast('Документ изменился. Повторите создание комментария на актуальном выделении.', true);
        return;
      }
      send({ ...request, bodyBase64: encodeBase64(body.trim()) });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally { creating = false; refresh(); }
  }

  const action = editor.addAction({ id: 'eaw.review.createComment', label: 'Создать комментарий',
    precondition: 'eawCanCreateComment', contextMenuGroupId: '1_modification', contextMenuOrder: 3,
    run: create });
  const click = () => { void create(); };
  button.addEventListener('click', click);
  const configuration = editor.onDidChangeConfiguration(refresh);
  const modelChange = editor.onDidChangeModel(refresh);
  // Refresh again on right-click, including state-only changes such as disconnects.
  const mouse = editor.onMouseDown(refresh);
  refresh();
  return { create, refresh, dispose() {
    button.removeEventListener('click', click);
    configuration.dispose(); modelChange.dispose(); mouse.dispose(); action.dispose(); context.reset();
  } };
}
