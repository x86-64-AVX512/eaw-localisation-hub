export const DISPLAY_VERSION = '0.8.7F1';
export const SEMVER_VERSION = '0.8.7-alpha.1';
export const PROTOCOL_VERSION = 15;

// Transport and CRDT budgets are intentionally separate. A full localisation
// seed is larger than an ordinary edit, while the in-memory Yjs state must stay
// comfortably below the 384 MiB container limit even when several rooms exist.
export const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
export const MAX_CRDT_UPDATE_BYTES = 8 * 1024 * 1024;
export const MAX_ROOM_STATE_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_ROOM_STATE_BYTES = 48 * 1024 * 1024;
export const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
export const MAX_LOADED_ROOMS = 64;
export const MAX_PERSISTED_ROOMS = 2048;
export const MAX_PERSISTED_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_CLIENTS_PER_ROOM = 64;
export const MAX_PRESENCES_PER_CONNECTION = 8;
export const MAX_CONNECTIONS_PER_USER = 32;
export const MAX_CONNECTIONS_TOTAL = 256;
export const ROOM_IDLE_MILLISECONDS = 60 * 1000;
export const PRESENCE_HEARTBEAT_MILLISECONDS = 10 * 1000;
export const PRESENCE_TTL_MILLISECONDS = 45 * 1000;
export const PRESENCE_SWEEP_MILLISECONDS = 5 * 1000;

export const TRACKED_PATH_PATTERN = /^localisation\/(?:russian|english|replace)\/.*\.yml$/i;
