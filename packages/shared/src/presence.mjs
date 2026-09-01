export function expiredPresenceIds(lastSeenByClient, now, ttlMilliseconds) {
  if (!(lastSeenByClient instanceof Map)) throw new TypeError('Presence timestamps must be a Map');
  if (!Number.isFinite(now) || !Number.isFinite(ttlMilliseconds) || ttlMilliseconds <= 0) {
    throw new TypeError('Presence expiry requires finite positive timing values');
  }
  const expired = [];
  for (const [clientId, lastSeen] of lastSeenByClient) {
    if (Number.isFinite(lastSeen) && now - lastSeen >= ttlMilliseconds) expired.push(clientId);
  }
  return expired;
}
