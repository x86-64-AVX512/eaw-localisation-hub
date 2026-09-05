const STORAGE_KEY = 'eaw-hub-notification-state-v1';
const DIGEST_MS = 10 * 60 * 1000;

function load() {
  try { return { cursor: 0, inbox: [], buckets: {}, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch { return { cursor: 0, inbox: [], buckets: {} }; }
}
function settings() {
  try { return { enabled: true, sound: true, ...JSON.parse(localStorage.getItem('eaw-hub-notifications') || '{}') }; }
  catch { return { enabled: true, sound: true }; }
}
function describe(event) {
  const details = event.details ?? {};
  if (event.type === 'comment-reply') return `${event.actor} ответил(а) в вашем обсуждении.`;
  if (event.type === 'suggestion-decision') return `${event.actor}: ваша правка ${details.decision === 'accepted' ? 'принята' : 'отклонена'}.`;
  if (event.type === 'ticket-state') return `${event.actor} изменил(а) тикет «${details.ticketTitle || details.ticketId}» (${details.action}).`;
  if (event.type === 'ticket-edited') return `${event.actor} редактировал(а) тикет «${details.ticketTitle || details.ticketId}».`;
  return `${event.actor}: ${event.type}`;
}

export function createNotificationCenter({ token, showToast }) {
  const state = load();
  const dialog = document.querySelector('#notifications-dialog');
  const list = document.querySelector('#notifications-list');
  const count = document.querySelector('#notifications-count');
  let timer;
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function beep() {
    if (!settings().sound) return;
    try {
      const audio = new AudioContext(); const oscillator = audio.createOscillator();
      oscillator.connect(audio.destination); oscillator.frequency.value = 660; oscillator.start();
      oscillator.stop(audio.currentTime + 0.08); oscillator.addEventListener('ended', () => audio.close());
    } catch { /* sound is optional */ }
  }
  function push(text, at = new Date().toISOString()) {
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
  function digestKey(event) {
    if (event.type === 'suggestion-decision') return 'suggestion-decision';
    if (event.type === 'ticket-state' || event.type === 'ticket-activity') return `ticket-state:${event.details?.ticketId ?? ''}`;
    if (event.type === 'ticket-edited') return `ticket-edited:${event.details?.ticketId ?? ''}`;
    return '';
  }
  function flushBuckets(now = Date.now()) {
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
  function ingest(event) {
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
        const payload = await response.json();
        for (const event of payload.events ?? []) ingest(event);
        state.cursor = Number(payload.cursor ?? state.cursor); save(); flushBuckets();
      }
    } catch { /* retry silently */ }
  }
  document.querySelector('#notifications-open').addEventListener('click', () => {
    state.inbox.forEach((item) => { item.read = true; }); render(); save(); dialog.showModal();
  });
  document.querySelector('#notifications-close').addEventListener('click', () => dialog.close());
  document.querySelector('#notifications-clear').addEventListener('click', () => { state.inbox = []; render(); save(); });
  render(); poll(); timer = setInterval(poll, 5000);
  return { dispose() { clearInterval(timer); } };
}
