export function expiredPresenceIds(lastSeenByClient: Map<string, number>, now: number, ttlMilliseconds: number): string[] {
  if (!(lastSeenByClient instanceof Map)) throw new TypeError('Presence timestamps must be a Map');
  if (!Number.isFinite(now) || !Number.isFinite(ttlMilliseconds) || ttlMilliseconds <= 0) {
    throw new TypeError('Presence expiry requires finite positive timing values');
  }
  const expired: string[] = [];
  for (const [clientId, lastSeen] of lastSeenByClient) {
    if (Number.isFinite(lastSeen) && now - lastSeen >= ttlMilliseconds) expired.push(clientId);
  }
  return expired;
}
