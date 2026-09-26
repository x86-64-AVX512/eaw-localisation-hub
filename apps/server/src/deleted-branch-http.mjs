import { AuthError } from './auth.mjs';

export async function handleDeletedBranchHttp({
  request, response, url, archive, authenticatedUser, sendJson,
}) {
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/deleted-branches') {
    await authenticatedUser(request);
    sendJson(response, 200, await archive.list());
    return true;
  }
  if (url.pathname === '/api/deleted-branches/document') {
    await authenticatedUser(request);
    const result = await archive.document(
      String(url.searchParams.get('branch') ?? ''),
      String(url.searchParams.get('path') ?? ''),
    );
    if (!result) throw new AuthError('Saved document not found in a deleted branch', 404, 'archive_not_found');
    sendJson(response, 200, result);
    return true;
  }
  return false;
}
