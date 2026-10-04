import type { AgentMessage } from './agent-message.ts';
import type { createAppState } from './app-state.ts';

export function applyAgentIdentity(state: ReturnType<typeof createAppState>,
  message: Extract<AgentMessage, { type: 'agentHello' }>): void {
  Object.assign(state, {
    user: message.user, userId: message.userId ?? '', color: message.color ?? state.color,
    roles: message.roles ?? [], avatarBase64: message.avatarBase64 ?? '',
    // A banner must reflect confirmed account state, not a local guess.
    recoveryStatus: message.recoveryStatus ?? '', temporaryPassword: message.temporaryPassword === true,
    workspace: message.workspace || state.workspace,
    version: message.version || state.version, serverVersion: message.serverVersion || state.serverVersion,
    trainingProgress: message.trainingProgress ?? state.trainingProgress,
    trainingProgressConfirmed: message.trainingProgressConfirmed === true,
  });
}
