import { requiredElement } from './dom-elements.ts';

const STORAGE_KEY = 'eaw-hub-notification-state-v1';
const DIGEST_MS = 10 * 60 * 1000;

interface NotificationEvent {
  id: string;
  type: string;
  actor: string;
  at: string;
  details?: Record<string, unknown>;
}
interface InboxItem { id: string; text: string; at: string; read: boolean }
interface DigestBucket { startedAt: number; events: NotificationEvent[] }
interface NotificationState {
  cursor: number;
  inbox: InboxItem[];
  buckets: Record<string, DigestBucket>;
}
interface NotificationCenterOptions {
  token: string;
  showToast: (message: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function notificationEvent(value: unknown): NotificationEvent | null {
  const item = asRecord(value);
  if (typeof item.id !== 'string' || typeof item.type !== 'string'
    || typeof item.actor !== 'string' || typeof item.at !== 'string') return null;
  return { id: item.id, type: item.type, actor: item.actor, at: item.at, details: asRecord(item.details) };
}

function load(): NotificationState {
  const empty: NotificationState = { cursor: 0, inbox: [], buckets: {} };
  try {
    const saved = asRecord(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as unknown);
    const cursor = Number(saved.cursor);
    if (Number.isFinite(cursor) && cursor >= 0) empty.cursor = cursor;
    if (Array.isArray(saved.inbox)) {
      empty.inbox = saved.inbox.filter((item: unknown): item is InboxItem => {
        const entry = asRecord(item);
        return typeof entry.id === 'string' && typeof entry.text === 'string'
          && typeof entry.at === 'string' && typeof entry.read === 'boolean';
      }).slice(0, 500);
    }
    for (const [key, value] of Object.entries(asRecord(saved.buckets))) {
      const bucket = asRecord(value);
      const startedAt = Number(bucket.startedAt);
      if (!Number.isFinite(startedAt) || !Array.isArray(bucket.events)) continue;
      empty.buckets[key] = {
        startedAt,
        events: bucket.events.map(notificationEvent).filter((event): event is NotificationEvent => event !== null),
      };
    }
  } catch { /* ignore damaged local state */ }
  return empty;
}
function settings(): { enabled: boolean; sound: boolean } {
  try {
    const saved = asRecord(JSON.parse(localStorage.getItem('eaw-hub-notifications') || '{}') as unknown);
    return { enabled: saved.enabled !== false, sound: saved.sound !== false };
  } catch { return { enabled: true, sound: true }; }
}
function describe(event: NotificationEvent): string {
  const details = event.details ?? {};
  if (event.type === 'comment-reply') return `${event.actor} ответил(а) в вашем обсуждении.`;
  if (event.type === 'suggestion-decision') return `${event.actor}: ваша правка ${details.decision === 'accepted' ? 'принята' : 'отклонена'}.`;
  if (event.type === 'ticket-state') return `${event.actor} изменил(а) тикет «${details.ticketTitle || details.ticketId}» (${details.action}).`;
  if (event.type === 'ticket-edited') return `${event.actor} редактировал(а) тикет «${details.ticketTitle || details.ticketId}».`;
  return `${event.actor}: ${event.type}`;
}

export function createNotificationCenter({ token, showToast }: NotificationCenterOptions) {
  const state = load();
  const dialog = requiredElement<HTMLDialogElement>('#notifications-dialog');
  const list = requiredElement<HTMLElement>('#notifications-list');
  const count = requiredElement<HTMLElement>('#notifications-count');
  let timer: ReturnType<typeof setInterval> | undefined;
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function beep() {
    if (!settings().sound) return;
    try {
      const audio = new AudioContext(); const oscillator = audio.createOscillator();
      oscillator.connect(audio.destination); oscillator.frequency.value = 660; oscillator.start();
      oscillator.stop(audio.currentTime + 0.08); oscillator.addEventListener('ended', () => audio.close());
    } catch { /* sound is optional */ }
  }
  function push(text: string, at = new Date().toISOString()): void {
    if (!settings().enabled) return;
    state.inbox.unshift({ id: crypto.randomUUID(), text, at, read: false });
    state.inbox = state.inbox.slice(0, 500); beep(); showToast(text); render(); save();
  }
  function render() {
    const unread = state.inbox.filter((item) => !item.read).length;
    count.textContent = String(unread);
    list.replaceChildren();
    if (!state.inbox.length) { list.textContent = 'Новых уведомлений нет.'; return; }
    for (const item of state.inbox) {
      const row = document.createElement('article'); row.className = `notification${item.read ? '' : ' unread'}`;
      const body = document.createElement('div'); body.textContent = item.text;
      const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleString();
      row.append(body, time); list.append(row);
    }
  }
  function digestKey(event: NotificationEvent): string {
    if (event.type === 'suggestion-decision') return 'suggestion-decision';
    if (event.type === 'ticket-state' || event.type === 'ticket-activity') return `ticket-state:${event.details?.ticketId ?? ''}`;
    if (event.type === 'ticket-edited') return `ticket-edited:${event.details?.ticketId ?? ''}`;
    return '';
  }
  function flushBuckets(now = Date.now()): void {
    for (const [key, bucket] of Object.entries(state.buckets)) {
      if (now - bucket.startedAt < DIGEST_MS) continue;
      const actors = [...new Set(bucket.events.map(({ actor }) => actor))].join(', ');
      if (key.startsWith('suggestion-decision')) {
        const accepted = bucket.events.filter(({ details }) => details?.decision === 'accepted').length;
        push(`Решения по вашим правкам за 10 минут: принято ${accepted}, отклонено ${bucket.events.length - accepted}.`);
      } else if (key.startsWith('ticket-state')) {
        push(`Действия с вашим тикетом за 10 минут: ${bucket.events.length}. Участники: ${actors}.`);
      } else {
        const totals = bucket.events.reduce((sum, event) => ({
          lines: sum.lines + Number(event.details?.lines ?? 0), words: sum.words + Number(event.details?.words ?? 0),
          characters: sum.characters + Number(event.details?.characters ?? 0),
        }), { lines: 0, words: 0, characters: 0 });
        push(`Ваш тикет редактировали: ${actors}. Изменено: строк ${totals.lines}, слов ${totals.words}, символов ${totals.characters}.`);
      }
      delete state.buckets[key];
    }
    save();
  }
  function ingest(event: NotificationEvent): void {
    if (event.type === 'comment-reply') { push(describe(event), event.at); return; }
    const key = digestKey(event);
    if (!key) return;
    state.buckets[key] ??= { startedAt: Date.parse(event.at) || Date.now(), events: [] };
    if (!state.buckets[key].events.some(({ id }) => id === event.id)) state.buckets[key].events.push(event);
  }
  async function poll() {
    try {
      const response = await fetch(`/api/events?after=${encodeURIComponent(state.cursor)}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (response.ok) {
        const payload = asRecord(await response.json() as unknown);
        for (const value of Array.isArray(payload.events) ? payload.events : []) {
          const event = notificationEvent(value);
          if (event) ingest(event);
        }
        const cursor = Number(payload.cursor ?? state.cursor);
        if (Number.isFinite(cursor) && cursor >= state.cursor) state.cursor = cursor;
        save(); flushBuckets();
      }
    } catch { /* retry silently */ }
  }
  requiredElement<HTMLButtonElement>('#notifications-open').addEventListener('click', () => {
    state.inbox.forEach((item) => { item.read = true; }); render(); save(); dialog.showModal();
  });
  requiredElement<HTMLButtonElement>('#notifications-close').addEventListener('click', () => dialog.close());
  requiredElement<HTMLButtonElement>('#notifications-clear').addEventListener('click', () => { state.inbox = []; render(); save(); });
  render(); poll(); timer = setInterval(poll, 5000);
  return { dispose() { clearInterval(timer); } };
}
