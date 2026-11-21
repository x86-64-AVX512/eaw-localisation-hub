import { isProofreadingProvider } from '../../../packages/shared/src/ai-localisation.mts';

export async function handleAiReviewApi(request, response, url, { assistant, readJsonBody, secureHeaders }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  try {
    const provider = url.searchParams.get('provider') ?? 'codex';
    if (!isProofreadingProvider(provider)) throw new Error('Неизвестный провайдер ИИ.');
    let payload;
    if (url.pathname === '/api/ai-localisation/status' && request.method === 'GET') {
      payload = provider === 'codex' ? await assistant.status(controller.signal) : assistant.providers[provider].status();
    } else if (provider === 'codex' && url.pathname === '/api/ai-localisation/usage' && request.method === 'GET') {
      payload = await assistant.usage(controller.signal);
    } else if (provider === 'codex' && request.method === 'POST' && [
      '/api/ai-localisation/login', '/api/ai-localisation/cancel-login', '/api/ai-localisation/logout',
    ].includes(url.pathname)) {
      payload = await assistant.changeAccount(url.pathname.split('/').at(-1));
    } else if (provider !== 'codex' && request.method === 'POST' && url.pathname === '/api/ai-localisation/api-key') {
      const body = await readJsonBody(request, 2048);
      payload = await assistant.setProviderKey(provider, body?.key, controller.signal);
    } else if (url.pathname === '/api/ai-localisation/run' && request.method === 'POST') {
      const body = await readJsonBody(request, 96 * 1024);
      payload = await assistant.run(body, controller.signal, provider);
    } else {
      response.writeHead(405).end();
      return;
    }
    if (!response.destroyed) {
      secureHeaders(response, 'application/json; charset=utf-8');
      response.end(JSON.stringify(payload));
    }
  } catch (error) {
    if (!response.destroyed) {
      response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: error.message }));
    }
  } finally {
    response.removeListener('close', abort);
  }
}
