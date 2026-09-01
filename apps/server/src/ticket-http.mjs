export async function handleTicketHttp(context) {
  const {
    request, response, url, readJsonBody, authenticatedUser, sendJson, ticketStore, ticketService,
  } = context;
  if (url.pathname === '/api/tickets' && request.method === 'GET') {
    await authenticatedUser(request);
    sendJson(response, 200, { tickets: ticketStore.list({ archived: url.searchParams.get('archived') === '1' }) });
    return true;
  }
  if (url.pathname === '/api/tickets' && request.method === 'POST') {
    const actor = await authenticatedUser(request);
    sendJson(response, 201, { ticket: await ticketStore.create(actor, await readJsonBody(request)) });
    return true;
  }
  const match = /^\/api\/tickets\/([^/]+)(?:\/(snapshot|apply|rebase|archive|files|conflict))?$/u.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const action = match[2] ?? '';
  const actor = await authenticatedUser(request);
  if (!action && request.method === 'GET') sendJson(response, 200, { ticket: ticketStore.get(id) });
  else if (!action && request.method === 'PATCH') {
    sendJson(response, 200, { ticket: await ticketStore.update(actor, id, await readJsonBody(request)) });
  } else if (!action && request.method === 'DELETE') {
    sendJson(response, 200, { ticket: await ticketService.delete(actor, id) });
  } else if (action === 'snapshot' && request.method === 'GET') {
    sendJson(response, 200, await ticketService.snapshot(id, url.searchParams.get('file') ?? ''));
  } else if (action === 'apply' && request.method === 'POST') {
    sendJson(response, 200, await ticketService.apply(actor, id, await readJsonBody(request)));
  } else if (action === 'rebase' && request.method === 'POST') {
    sendJson(response, 200, await ticketService.rebase(actor, id, await readJsonBody(request)));
  } else if (action === 'archive' && request.method === 'POST') {
    sendJson(response, 200, { ticket: await ticketStore.archive(actor, id) });
  } else if (action === 'files' && request.method === 'PUT') {
    sendJson(response, 200, await ticketService.setFiles(actor, id, (await readJsonBody(request)).files));
  } else if (action === 'conflict' && request.method === 'POST') {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ticket: await ticketService.setConflict(
      actor, id, body.operation, Array.isArray(body.files) ? body.files.map(String) : [],
    ) });
  } else return false;
  return true;
}
