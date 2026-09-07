import { sendWithBackpressure } from './protocol-limits.mjs';

export function watchTicketCatalog(ticketStore, rooms) {
  ticketStore.onChanged = async (revision) => {
    const message = JSON.stringify({ type: 'tickets-changed', revision });
    for (const result of await Promise.allSettled([...rooms.values()])) {
      if (result.status !== 'fulfilled') continue;
      for (const socket of result.value.clients) sendWithBackpressure(socket, message);
    }
  };
}
