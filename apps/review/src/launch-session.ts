const STORAGE_KEY = 'eaw-review-session-token';

export function readLaunchToken(params: URLSearchParams): string {
  const incoming = params.get('token');
  try {
    if (!incoming) return sessionStorage.getItem(STORAGE_KEY) ?? '';
    sessionStorage.setItem(STORAGE_KEY, incoming);
    params.delete('token');
    history.replaceState(history.state, '', `${location.pathname}${location.search}#${params}`);
  } catch {
    // Storage can be disabled in a standalone browser. Keep the launch URL usable.
  }
  return incoming ?? '';
}

export function reviewFragment(token: string, fields: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(fields);
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === token) return params;
  } catch { /* The launch URL is the fallback when storage is unavailable. */ }
  params.set('token', token);
  return params;
}

export function clearLaunchToken(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}
