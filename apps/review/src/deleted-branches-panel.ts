import { uiText } from '../../../packages/shared/src/ui-language.mts';
import type * as Monaco from 'monaco-editor';
import { reviewFontFamily } from './editor-font.ts';
import { requiredButton, requiredDialog, requiredElement, requiredInput } from './dom-elements.ts';
import { decodeBase64 } from './review-utilities.ts';

interface ArchivedBranch {
  branch: string;
  commit: string;
  files: string[];
  unknownCount: number;
  tickets: number;
}

interface ArchivedDiscussion {
  id: string;
  author: string;
  status: string;
  line: number | null;
  orphaned: boolean;
  originalText: string;
  replacementText: string;
  messages: { id: string; author: string; body: string; createdAt: string }[];
}

interface ArchivedDocument {
  branch: string;
  relativePath: string;
  commit: string;
  textBase64: string;
  comments: ArchivedDiscussion[];
  suggestions: ArchivedDiscussion[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDeletedBranchesPanel({ monaco, token, showToast }: {
  monaco: typeof Monaco;
  token: string;
  showToast: (message: string, error?: boolean) => void;
}) {
  const openButton = requiredButton('#deleted-branches-open');
  const closeButton = requiredButton('#deleted-branches-close');
  const refreshButton = requiredButton('#deleted-branches-refresh');
  const openPathButton = requiredButton('#deleted-branches-open-path');
  const pathInput = requiredInput('#deleted-branches-path');
  const dialog = requiredDialog('#deleted-branches-dialog');
  const branchesElement = requiredElement<HTMLElement>('#deleted-branches-list');
  const filesElement = requiredElement<HTMLElement>('#deleted-branches-files');
  const editorElement = requiredElement<HTMLElement>('#deleted-branches-editor');
  const commentsElement = requiredElement<HTMLElement>('#deleted-branches-comments');
  const selectionElement = requiredElement<HTMLElement>('#deleted-branches-selection');
  const noticeElement = requiredElement<HTMLElement>('#deleted-branches-notice');
  let branches: ArchivedBranch[] = [];
  let selectedBranch = '';
  let selectedFile = '';
  let preview: Monaco.editor.IStandaloneCodeEditor | null = null;
  let disposed = false;
  let requestSequence = 0;
  let listSequence = 0;

  async function api<T>(route: string): Promise<T> {
    const response = await fetch(route, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function clearPreview() {
    requestSequence += 1;
    preview?.dispose(); preview = null;
    editorElement.replaceChildren();
    commentsElement.replaceChildren();
    selectedFile = '';
    selectionElement.textContent = uiText("Выберите ветку и файл");
  }

  function renderDiscussionGroup(title: string, items: ArchivedDiscussion[]) {
    if (!items.length) return;
    const heading = document.createElement('h3');
    heading.textContent = `${title} · ${items.length}`;
    commentsElement.append(heading);
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'deleted-branch-comment';
      const location = document.createElement('button');
      location.textContent = item.line ? uiText("Строка {0}", item.line) : uiText("Позиция утрачена");
      location.disabled = !item.line;
      location.addEventListener('click', () => {
        if (item.line) preview?.revealLineInCenter(item.line);
      });
      const meta = document.createElement('strong');
      meta.textContent = `${item.author || uiText("Участник")} · ${item.status || uiText("открыто")}`;
      card.append(location, meta);
      if (item.originalText || item.replacementText) {
        const change = document.createElement('p');
        change.textContent = `${item.originalText} → ${item.replacementText}`;
        card.append(change);
      }
      for (const message of item.messages) {
        const body = document.createElement('p');
        body.textContent = `${message.author || uiText("Участник")}: ${message.body}`;
        card.append(body);
      }
      commentsElement.append(card);
    }
  }

  async function openFile(relativePath: string) {
    if (!selectedBranch || !relativePath) return;
    const sequence = ++requestSequence;
    selectionElement.textContent = uiText("Загрузка {0}…", relativePath);
    try {
      const query = new URLSearchParams({ branch: selectedBranch, path: relativePath });
      const payload = await api<ArchivedDocument>(`/api/deleted-branches/document?${query}`);
      if (!dialog.open || sequence !== requestSequence || payload.branch !== selectedBranch) return;
      preview?.dispose();
      editorElement.replaceChildren();
      preview = monaco.editor.create(editorElement, {
        value: decodeBase64(payload.textBase64), language: 'eaw-yaml',
        readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontFamily: reviewFontFamily(),
        wordWrap: 'on', wrappingStrategy: 'advanced', scrollBeyondLastLine: false,
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
      });
      selectedFile = relativePath;
      selectionElement.textContent = `${payload.branch}:${relativePath}`;
      noticeElement.textContent = uiText("Серверная копия · исходный коммит {0}. Только чтение. Для продолжения работы администратор должен восстановить ветку либо перенести её в новую.", payload.commit.slice(0, 12));
      commentsElement.replaceChildren();
      renderDiscussionGroup(uiText("Комментарии"), payload.comments);
      renderDiscussionGroup(uiText("Правки"), payload.suggestions);
      if (!payload.comments.length && !payload.suggestions.length) {
        commentsElement.textContent = uiText("Обсуждений и правок в сохранённой комнате нет.");
      }
      for (const button of filesElement.querySelectorAll('button')) {
        button.classList.toggle('active', button.textContent === selectedFile);
      }
    } catch (error) {
      if (sequence !== requestSequence) return;
      selectionElement.textContent = uiText("Не удалось открыть сохранённый файл");
      showToast(errorMessage(error), true);
    }
  }

  function renderFiles(branch: ArchivedBranch) {
    filesElement.replaceChildren();
    for (const file of branch.files) {
      const button = document.createElement('button');
      button.textContent = file;
      button.addEventListener('click', () => { void openFile(file); });
      filesElement.append(button);
    }
    if (branch.unknownCount) {
      const hint = document.createElement('p');
      hint.className = 'dialog-hint';
      hint.textContent = uiText("Ещё {0} старых комнат без восстановленного пути. Если путь известен, введите его ниже.", branch.unknownCount);
      filesElement.append(hint);
    }
  }

  function selectBranch(branch: ArchivedBranch) {
    selectedBranch = branch.branch;
    clearPreview();
    renderFiles(branch);
    noticeElement.textContent = uiText("Последний известный коммит: {0}. Тикетов: {1}. Ветка не будет создана автоматически.", branch.commit.slice(0, 12), branch.tickets);
    for (const button of branchesElement.querySelectorAll('button')) {
      button.classList.toggle('active', button.textContent?.startsWith(`${branch.branch} ·`) ?? false);
    }
  }

  function renderBranches() {
    branchesElement.replaceChildren();
    if (!branches.length) {
      branchesElement.textContent = uiText("Удалённых веток с сохранёнными документами нет.");
      filesElement.replaceChildren();
      clearPreview();
      return;
    }
    for (const branch of branches) {
      const button = document.createElement('button');
      button.textContent = uiText("{0} · {1} файлов", branch.branch, branch.files.length + branch.unknownCount);
      button.addEventListener('click', () => selectBranch(branch));
      branchesElement.append(button);
    }
    selectBranch(branches.find((item) => item.branch === selectedBranch) ?? branches[0]);
  }

  async function reload() {
    const sequence = ++listSequence;
    branchesElement.textContent = uiText("Проверка удалённых веток…");
    refreshButton.disabled = true;
    try {
      const payload = await api<{ branches: ArchivedBranch[] }>('/api/deleted-branches');
      if (!dialog.open || disposed || sequence !== listSequence) return;
      branches = payload.branches;
      renderBranches();
    } catch (error) {
      if (dialog.open && sequence === listSequence) {
        branchesElement.textContent = uiText("Не удалось получить список: {0}", errorMessage(error));
      }
    } finally {
      if (sequence === listSequence) refreshButton.disabled = false;
    }
  }

  openButton.addEventListener('click', () => { dialog.showModal(); void reload(); });
  closeButton.addEventListener('click', () => dialog.close());
  refreshButton.addEventListener('click', () => { void reload(); });
  openPathButton.addEventListener('click', () => { void openFile(pathInput.value.trim()); });
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void openFile(pathInput.value.trim()); }
  });
  dialog.addEventListener('close', () => { listSequence += 1; clearPreview(); });
  return { dispose() { disposed = true; listSequence += 1; clearPreview(); } };
}
