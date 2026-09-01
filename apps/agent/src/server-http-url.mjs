export function serverHttpUrl(server, route) {
  const endpoint = new URL(server);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error('Agent server URL must use ws:// or wss://');
  }

  const routeText = String(route ?? '');
  if (!routeText.startsWith('/') || routeText.startsWith('//')) {
    throw new Error('Agent server route must be an absolute-path reference');
  }
  const target = new URL(routeText, 'http://eaw-hub.invalid');
  if (target.origin !== 'http://eaw-hub.invalid' || target.hash) {
    throw new Error('Agent server route must not change origin or contain a fragment');
  }

  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  endpoint.pathname = target.pathname;
  endpoint.search = target.search;
  endpoint.hash = '';
  return endpoint;
}
