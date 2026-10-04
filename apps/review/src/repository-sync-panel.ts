import { uiText, uiMessage } from '../../../packages/shared/src/ui-language.mts';
import { confirmAction } from './confirm-action.ts';
import { requiredButton, requiredDialog, requiredElement } from './dom-elements.ts';

type Checkout = { branch: string; head: string; upstream: string; remote: string; remoteRef: string };
type SyncStatus = { stage: string; reason?: string; message: string; repository?: string;
  branch?: string; behind?: number; busy?: boolean; requestId?: string; checkout?: Checkout | null; error?: string };
class ApiError extends Error {}

export function createRepositorySyncPanel({ token, showToast, confirm = confirmAction }: {
  token: string; showToast(text: string, error?: boolean): void; confirm?: typeof confirmAction;
}) {
  const button = requiredButton('#repository-update');
  const dialog = requiredDialog('#repository-sync-dialog');
  const message = requiredElement('#repository-sync-message');
  const progress = requiredElement<HTMLProgressElement>('#repository-sync-progress');
  let disposed = false, confirming = false, pending = false;
  let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const controllers = new Set<AbortController>();
  const busy = (status: SyncStatus) => status.busy || ['checking', 'fetching', 'updating'].includes(status.stage);

  async function api(body?: object): Promise<SyncStatus> {
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/repository-sync', { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        cache: 'no-store', signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      const status = await response.json() as SyncStatus;
      if (!response.ok) throw new ApiError(status.error || uiText("Не удалось обратиться к Desktop Agent."));
      return status;
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  function render(status: SyncStatus): void {
    message.textContent = [status.repository, status.checkout?.branch || status.branch,
      uiMessage(status.message), status.behind ? uiText("Новых коммитов: {0}", status.behind) : ''].filter(Boolean).join('\n');
    progress.hidden = !busy(status);
    button.disabled = pending = Boolean(busy(status));
    button.textContent = pending ? uiText("Обновление репозитория…") : uiText("Обновить репозиторий");
    button.title = uiMessage(status.message);
  }
  function show(status: SyncStatus): void {
    render(status); if (!dialog.open) dialog.showModal();
  }
  async function poll(ticket: number): Promise<void> {
    try {
      const status = await api();
      if (disposed || ticket !== generation) return;
      render(status);
      if (busy(status)) timer = setTimeout(() => { void poll(ticket); }, 1000);
      else showToast(uiMessage(status.message), ['blocked', 'error'].includes(status.stage));
    } catch (error) {
      if (disposed || ticket !== generation) return;
      // A lost response may hide an accepted update; read status, never POST again.
      message.textContent = uiText("Связь с Agent потеряна: {0}. Повторяем проверку статуса…", String(error));
      timer = setTimeout(() => { void poll(ticket); }, 3000);
    }
  }
  async function update(): Promise<void> {
    if (disposed || confirming || pending) return;
    confirming = true;
    const ticket = ++generation;
    try {
      const status = await api();
      if (disposed) return;
      if (busy(status)) { show(status); void poll(ticket); return; }
      if (!status.checkout) throw new Error(uiText("Текущая Git-ветка недоступна (возможно, detached HEAD)."));
      const accepted = await confirm(button,
        uiText("Обновить текущую Git-ветку «{0}» из «{1}» во всём репозитории? ", status.checkout.branch, status.checkout.upstream)
        + uiText("Только fast-forward. Локальные изменения не будут удалены или спрятаны."), { label: uiText("Обновить") });
      if (!accepted || disposed) return;
      show({ ...status, stage: 'checking', message: uiText("Запрашиваем обновление у Agent…"), busy: true });
      try {
        const result = await api({ action: 'update', confirmed: true, checkout: status.checkout });
        if (disposed) return;
        render(result);
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiError) {
          show({ ...status, stage: 'blocked', busy: false, message: error.message });
          showToast(error.message, true); return;
        }
        message.textContent = String(error);
      }
      // A network failure may hide an accepted POST, so recover via GET.
      void poll(ticket);
    } catch (error) { if (!disposed) showToast(String(error), true); }
    finally { confirming = false; }
  }
  button.addEventListener('click', update);
  return { dispose() {
    disposed = true; generation++; clearTimeout(timer);
    for (const controller of controllers) controller.abort();
    button.removeEventListener('click', update);
  } };
}
