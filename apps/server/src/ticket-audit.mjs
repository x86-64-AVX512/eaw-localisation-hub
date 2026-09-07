export function auditTicketAction(audit, store, actor, action, id, operation) {
  if (!audit) return operation();
  let ticket;
  try { ticket = id ? store.get(id) : null; } catch { /* invalid targets are recorded as failed operations */ }
  const details = ticket ? {
    title: ticket.title, creatorId: ticket.creatorId, previousStatus: ticket.status,
    files: ticket.files.map((file) => file.slice(0, 256)),
  } : {};
  return audit.run(actor, `ticket-${action}`, id || 'new-ticket', details, operation,
    { destructive: ['delete', 'files'].includes(action) });
}
