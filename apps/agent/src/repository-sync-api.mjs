/** Authenticated loopback API; no independent Git mutation path. */
export async function handleRepositorySyncApi(request, response, { hub, readJsonBody, secureHeaders }) {
  secureHeaders(response, 'application/json; charset=utf-8');
  try {
    const service = hub.repositorySync;
    if (!service || service.stopped) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Сервис обновления репозитория недоступен.' })); return;
    }
    if (request.method === 'GET') {
      response.end(JSON.stringify(service.reviewStatus())); return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const body = await readJsonBody(request, 4096);
    if (body?.action !== 'update' || body?.confirmed !== true || !body.checkout
      || typeof body.checkout.branch !== 'string' || typeof body.checkout.head !== 'string') {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'Требуется подтверждение обновления текущей Git-ветки.' })); return;
    }
    const requestId = service.requestUpdate(body.checkout);
    response.statusCode = 202;
    response.end(JSON.stringify({ requestId, ...service.reviewStatus() }));
  } catch (error) {
    response.statusCode = 409;
    response.end(JSON.stringify({ error: error.message }));
  }
}
