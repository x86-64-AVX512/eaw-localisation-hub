function json(response, status, payload, secureHeaders) {
  secureHeaders(response, 'application/json; charset=utf-8');
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

export async function handleTicketReviewApi(context) {
  const {
    request, requestUrl, response, authorised, hub, options, readJsonBody, secureHeaders,
  } = context;
  if (!requestUrl.pathname.startsWith('/api/tickets')) return false;
  if (!authorised()) {
    response.writeHead(401).end();
    return true;
  }
  try {
    if (requestUrl.pathname === '/api/tickets') {
      const payload = request.method === 'POST'
        ? await hub.ticketRequest('/api/tickets', {
          method: 'POST', body: JSON.stringify({
            ...(await readJsonBody(request)),
            baseBranch: options.workspace,
            baseCommit: hub.currentGitCommit(),
          }),
        })
        : await hub.ticketRequest(`/api/tickets${requestUrl.search}`, { method: 'GET' });
      json(response, 200, payload, secureHeaders);
      return true;
    }
    const match = /^\/api\/tickets\/([0-9a-f-]{36})(?:\/(summary|diff|apply|rebase|archive|files))?$/u
      .exec(requestUrl.pathname);
    if (!match) return false;
    const id = match[1];
    const action = match[2] ?? '';
    let payload;
    if (action === 'summary' && request.method === 'GET') payload = await hub.ticketWorkflow.summary(id);
    else if (action === 'diff' && request.method === 'GET') {
      payload = await hub.ticketWorkflow.diff(id, requestUrl.searchParams.get('file') ?? '');
    }
    else if (action === 'apply' && request.method === 'POST') payload = await hub.ticketWorkflow.apply(id);
    else if (action === 'rebase' && request.method === 'POST') payload = await hub.ticketWorkflow.rebase(id);
    else if (action === 'archive' && request.method === 'POST') {
      payload = await hub.ticketRequest(`/api/tickets/${id}/archive`, { method: 'POST', body: '{}' });
    } else if (action === 'files' && request.method === 'PUT') {
      payload = await hub.ticketRequest(`/api/tickets/${id}/files`, {
        method: 'PUT', body: JSON.stringify(await readJsonBody(request)),
      });
    } else if (!action && request.method === 'DELETE') {
      payload = await hub.ticketRequest(`/api/tickets/${id}`, { method: 'DELETE' });
    } else if (!action && request.method === 'PATCH') {
      payload = await hub.ticketRequest(`/api/tickets/${id}`, {
        method: 'PATCH', body: JSON.stringify(await readJsonBody(request)),
      });
    } else if (!action && request.method === 'GET') {
      payload = await hub.ticketRequest(`/api/tickets/${id}`, { method: 'GET' });
    } else return false;
    json(response, 200, payload, secureHeaders);
  } catch (error) {
    json(response, 400, { error: error.message }, secureHeaders);
  }
  return true;
}
