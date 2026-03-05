// types.ts (shared)
export type MessageType =
  | "JOIN_ROOM"
  | "PEER_JOINED"
  | "OFFER"
  | "ANSWER"
  | "ICE_CANDIDATE"
  | "TRANSFER_COMPLETE"
  | "DISCONNECT"
  | "ROOM_EXPIRED"
  | "ERROR";

export interface SignalMessage {
  type: MessageType;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// Env interface — matches wrangler.toml bindings
export interface Env {
  TRANSFER_ROOM: DurableObjectNamespace;
  RATE_LIMIT_KV: KVNamespace;
  CF_CALLS_APP_ID: string;
  CF_CALLS_APP_SECRET: string;
  ENVIRONMENT: string;
  SESSION_TTL_SECONDS: string;
  MAX_FILE_SIZE_MB: string;
}
