import type { createAgentConnection } from './agent-connection.ts';
export function createDocumentCloser({ state, editingMode, refresh, connection }: {
  state: {path:string;ready:boolean;presences:Map<string,unknown>};
  editingMode:{flushSuggestion():unknown}; refresh:()=>void;
  connection:()=>ReturnType<typeof createAgentConnection>|undefined;
}) {
  let closing = false;
  return async function closeActiveDocument({flush = true} = {}) {
    if (closing || !state.path) return;
    closing = true; editingMode.flushSuggestion(); state.ready = false; state.presences.clear(); refresh();
    connection()?.send({type:'deactivate',path:state.path}); connection()?.send({type:'close',path:state.path});
    if (flush) await connection()?.flush();
  };
}
