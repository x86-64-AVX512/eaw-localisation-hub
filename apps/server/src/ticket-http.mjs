import { auditTicketAction } from './ticket-audit.mjs';

export async function handleTicketHttp(context) {
  const {
    request, response, url, readJsonBody, authenticatedUser, sendJson, ticketStore, ticketService, auditLog,
  } = context;
  const run = (actor, action, id, operation) => auditTicketAction(auditLog, ticketStore, actor, action, id, operation);
  if (url.pathname === '/api/tickets/revision' && request.method === 'GET') {
    await authenticatedUser(request);
    sendJson(response, 200, { revision: ticketStore.revision });
    return true;
  }
  if (url.pathname === '/api/tickets' && request.method === 'GET') {
    await authenticatedUser(request);
    sendJson(response, 200, { tickets: ticketStore.list({ archived: url.searchParams.get('archived') === '1' }), revision: ticketStore.revision });
    return true;
  }
  if (url.pathname === '/api/tickets' && request.method === 'POST') {
    const actor = await authenticatedUser(request);
    const body = await readJsonBody(request);
    sendJson(response, 201, await run(actor, 'create', '', async () => ({ ticket: await ticketStore.create(actor, body) })));
    return true;
  }
  const match = /^\/api\/tickets\/([^/]+)(?:\/(snapshot|apply|rebase|archive|files|conflict))?$/u.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const action = match[2] ?? '';
  const actor = await authenticatedUser(request);
  if (!action && request.method === 'GET') sendJson(response, 200, { ticket: ticketStore.get(id) });
  else if (!action && request.method === 'PATCH') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await run(actor, 'update', id, async () => ({ ticket: await ticketStore.update(actor, id, body) })));
  } else if (!action && request.method === 'DELETE') {
    sendJson(response, 200, await run(actor, 'delete', id, async () => ({ ticket: await ticketService.delete(actor, id) })));
  } else if (action === 'snapshot' && request.method === 'GET') {
    sendJson(response, 200, await ticketService.snapshot(id, url.searchParams.get('file') ?? ''));
  } else if (action === 'apply' && request.method === 'POST') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await run(actor, 'apply', id, () => ticketService.apply(actor, id, body)));
  } else if (action === 'rebase' && request.method === 'POST') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await run(actor, 'rebase', id, () => ticketService.rebase(actor, id, body)));
  } else if (action === 'archive' && request.method === 'POST') {
    sendJson(response, 200, await run(actor, 'archive', id, async () => ({ ticket: await ticketStore.archive(actor, id) })));
  } else if (action === 'files' && request.method === 'PUT') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await run(actor, 'files', id, () => ticketService.setFiles(actor, id, body.files)));
  } else if (action === 'conflict' && request.method === 'POST') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await run(actor, 'conflict', id, async () => ({ ticket: await ticketService.setConflict(
      actor, id, body.operation, Array.isArray(body.files) ? body.files.map(String) : [],
    ) })));
  } else return false;
  return true;
}
