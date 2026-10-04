export const WORKSPACE_SLEEP_KEY = 'eaw-hub-workspace-sleep-v1';
export interface WorkspaceSleepSettings { enabled: boolean; idleMinutes: number; warmLimit: number }
export function workspaceSleepSettings(value: Partial<WorkspaceSleepSettings> | null): WorkspaceSleepSettings {
  return { enabled:value?.enabled !== false,
    idleMinutes:[1,5,10,15,30].includes(value?.idleMinutes ?? 0) ? value!.idleMinutes! : 5,
    warmLimit:[4,8,12,20].includes(value?.warmLimit ?? 0) ? value!.warmLimit! : 4 };
}
export interface SleepableSession { id:string; lastUsed:number; protected:boolean; pending:boolean }
// The limit is deliberately soft: drafts/undo/offline buffers must never be
// evicted to hit a RAM target. Under pressure only a minute-idle tab is eligible.
export function workspaceSleepCandidates<T extends SleepableSession>(sessions: T[], active: string,
  settings: WorkspaceSleepSettings, now: number): T[] {
  if (!settings.enabled) return [];
  let excess = Math.max(0, sessions.length - settings.warmLimit);
  return [...sessions].sort((a,b) => a.lastUsed-b.lastUsed).filter(session => {
    if (session.id === active || session.protected || session.pending) return false;
    const idle = now-session.lastUsed;
    if (idle >= settings.idleMinutes*60_000) { excess = Math.max(0,excess-1); return true; }
    if (excess && idle >= 60_000) { excess--; return true; }
    return false;
  });
}
