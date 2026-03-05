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

export interface TransferMetadata {
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  iv: string;
}

export enum AppState {
  Waiting = "waiting",
  Live = "live",
  Transferring = "transferring",
  Ended = "ended",
}
