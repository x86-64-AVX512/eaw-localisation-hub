import { getUiLanguage, uiText } from '../../../packages/shared/src/ui-language.mts';
import { requiredElement } from './dom-elements.ts';

interface RateLimit {
  name: string;
  remainingPercent: number;
  durationMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexUsage {
  signedIn: boolean;
  live: boolean;
  rateLimits: { plan: string | null; limits: RateLimit[] } | null;
  context: {
    usedTokens: number;
    rolloverTokens: number;
    modelWindowTokens: number | null;
    idleResetAt: number | null;
    active: boolean;
    estimated: boolean;
  };
}

function bindUsageTooltip(triggerId: string, popupId: string) {
  const trigger = requiredElement<HTMLButtonElement>(triggerId);
  const popup = requiredElement(popupId);
  let dismiss: ReturnType<typeof setTimeout> | undefined;
  function position() {
    const anchor = trigger.getBoundingClientRect();
    const width = popup.getBoundingClientRect().width;
    popup.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    popup.style.bottom = `${innerHeight - anchor.top}px`;
  }
  const cancelDismiss = () => clearTimeout(dismiss);
  function show() {
    cancelDismiss();
    if (!popup.matches(':popover-open')) popup.showPopover();
    position();
  }
  function hide() {
    cancelDismiss();
    popup.hidePopover();
  }
  function leave() {
    cancelDismiss();
    dismiss = setTimeout(() => {
      if (!trigger.matches(':hover, :focus-visible') && !popup.matches(':hover')) hide();
    }, 120);
  }
  function toggle() {
    const open = popup.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(open));
    if (open) position();
  }
  const hover = (event: PointerEvent) => { if (event.pointerType === 'mouse') show(); };
  trigger.addEventListener('pointerenter', hover);
  trigger.addEventListener('pointerleave', leave);
  trigger.addEventListener('focus', show);
  trigger.addEventListener('blur', leave);
  popup.addEventListener('pointerenter', cancelDismiss);
  popup.addEventListener('pointerleave', leave);
  popup.addEventListener('toggle', toggle);
  window.addEventListener('resize', toggle);
  return { hide, dispose() {
    hide();
    trigger.removeEventListener('pointerenter', hover);
    trigger.removeEventListener('pointerleave', leave);
    trigger.removeEventListener('focus', show);
    trigger.removeEventListener('blur', leave);
    popup.removeEventListener('pointerenter', cancelDismiss);
    popup.removeEventListener('pointerleave', leave);
    popup.removeEventListener('toggle', toggle);
    window.removeEventListener('resize', toggle);
  } };
}

export function createAiUsagePanel() {
  const tooltips = [bindUsageTooltip('#ai-limits-trigger', '#ai-limits-details'),
    bindUsageTooltip('#ai-context-trigger', '#ai-context-details')];
  const limitsRing = requiredElement('#ai-limits-ring');
  const limitsPercent = requiredElement('#ai-limits-percent');
  const contextRing = requiredElement('#ai-context-ring');
  const plan = requiredElement('#ai-limits-plan');
  const windows = requiredElement('#ai-limits-windows');
  const unavailable = requiredElement('#ai-limits-unavailable');
  const cached = requiredElement('#ai-limits-cached');
  const percent = requiredElement('#ai-context-percent');
  const count = requiredElement('#ai-context-count');
  const rollover = requiredElement('#ai-context-rollover');
  const idle = requiredElement('#ai-context-idle');

  function render(usage: CodexUsage | null, signedIn = false) {
    if (!usage) {
      limitsPercent.textContent = percent.textContent = '—';
      limitsRing.style.removeProperty('--used');
      contextRing.style.removeProperty('--used');
      plan.hidden = windows.hidden = rollover.hidden = idle.hidden = cached.hidden = true;
      windows.replaceChildren();
      unavailable.hidden = false;
      count.textContent = signedIn ? uiText('Контекст пока недоступен.') : uiText('Аккаунт Codex для Review не подключён.');
      return;
    }
    const number = new Intl.NumberFormat(getUiLanguage());
    const time = new Intl.DateTimeFormat(getUiLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
    const limits = usage.rateLimits?.limits ?? [];
    const source = usage.rateLimits?.plan;
    plan.hidden = !source || source === 'unknown';
    if (source) {
      const label = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', business: 'Business', team: 'Team', edu: 'Edu' }[source] ?? source;
      plan.textContent = uiText('Тариф ChatGPT: {0}', label);
    }
    windows.hidden = limits.length === 0;
    cached.hidden = usage.live || limits.length === 0;
    unavailable.hidden = limits.length > 0;
    const remaining = limits.length ? Math.min(...limits.map(item => item.remainingPercent)) : null;
    const accountWindows = limits.filter(item => !item.name);
    const headlineWindows = accountWindows.length ? accountWindows : limits.slice(0, 1);
    limitsPercent.textContent = headlineWindows.map(item => `${number.format(item.remainingPercent)}%`).join(' / ') || '—';
    limitsRing.style.setProperty('--used', `${remaining === null ? 0 : 100 - remaining}%`);
    windows.replaceChildren(...limits.map(item => {
      const line = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'ai-limit-row';
      const title = document.createElement('span');
      const label = item.durationMinutes === 300 ? uiText('5-часовой лимит')
        : item.durationMinutes === 10_080 ? uiText('Недельный лимит')
        : item.durationMinutes === null ? uiText('Лимит Codex')
        : uiText('Лимит на {0} мин.', number.format(item.durationMinutes));
      title.textContent = item.name ? `${item.name} · ${label}` : label;
      const remaining = document.createElement('strong');
      remaining.textContent = uiText('Осталось {0}%', number.format(item.remainingPercent));
      row.append(title, remaining);
      line.append(row);
      if (item.resetsAt !== null) {
        const reset = document.createElement('time');
        reset.dateTime = new Date(item.resetsAt).toISOString();
        reset.textContent = uiText('Обновится {0}', time.format(item.resetsAt));
        line.append(reset);
      }
      return line;
    }));

    const context = usage.context;
    rollover.hidden = false;
    const used = number.format(context.usedTokens);
    const limit = number.format(context.rolloverTokens);
    const fill = Math.min(100, Math.floor(context.usedTokens / context.rolloverTokens * 100));
    percent.textContent = `${number.format(fill)}%`;
    contextRing.style.setProperty('--used', `${fill}%`);
    count.textContent = context.active
      ? uiText(context.estimated ? 'Примерно {0} из {1} токенов до нового чата.' : '{0} из {1} токенов до нового чата.', used, limit)
      : uiText('Новый чат откроется при следующем запросе к Luna.');
    rollover.textContent = context.usedTokens >= context.rolloverTokens
      ? uiText('Порог достигнут. Следующий запрос к Luna откроет новый чат.')
      : uiText('Порог нового чата: {0} токенов с учётом следующего запроса.', limit);
    if (context.modelWindowTokens) {
      rollover.textContent += ` ${uiText('Окно модели: {0} токенов.', number.format(context.modelWindowTokens))}`;
    }
    idle.hidden = context.idleResetAt === null;
    if (context.idleResetAt !== null) idle.textContent = uiText('Без новых проверок чат закроется в {0}.', time.format(context.idleResetAt));
  }
  return { render, hide: () => tooltips.forEach(tooltip => tooltip.hide()),
    dispose: () => tooltips.forEach(tooltip => tooltip.dispose()) };
}
