import { russianDictionaryPayload } from './spelling-dictionary.mjs';

export async function handleSpellingHttp({
  request, response, url, authStore, authenticatedUser, readJsonBody, sendJson,
}) {
  if (request.method === 'GET' && url.pathname === '/api/spelling/dictionary') {
    await authenticatedUser(request);
    sendJson(response, 200, await russianDictionaryPayload());
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/spelling/words') {
    const actor = await authenticatedUser(request);
    sendJson(response, 200, { words: authStore.spellingWords(actor) });
    return true;
  }
  if (request.method === 'PUT' && url.pathname === '/api/spelling/words') {
    const actor = await authenticatedUser(request);
    const body = await readJsonBody(request);
    sendJson(response, 200, { words: await authStore.addSpellingWord(actor, body.word) });
    return true;
  }
  return false;
}
