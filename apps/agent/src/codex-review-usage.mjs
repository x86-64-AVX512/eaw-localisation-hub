export function reviewRateLimits(payload) {
  const summary = payload?.rateLimits;
  const byId = payload?.rateLimitsByLimitId ?? {};
  const codex = byId.codex ?? summary;
  const buckets = [['codex', codex], ...Object.entries(byId).filter(([id]) => id !== 'codex')];
  const limits = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || (id !== 'codex' && (bucket === codex || (bucket.limitId === codex?.limitId && bucket.limitId))))
      continue;
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!Number.isFinite(window?.usedPercent)) continue;
      limits.push({
        name: id === 'codex' ? '' : bucket.limitName || id,
        remainingPercent: Math.min(100, Math.max(0, 100 - window.usedPercent)),
        durationMinutes:
          Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0
            ? window.windowDurationMins
            : null,
        resetsAt:
          Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 && window.resetsAt < 8.64e12
            ? window.resetsAt * 1000
            : null,
      });
    }
  }
  return { plan: codex?.planType ?? summary?.planType ?? null, limits };
}
