import { DurableObject } from "cloudflare:workers";
import { Env } from "./types";

interface RoomState {
  code: string;
  senderSocket: WebSocket | null;
  receiverSocket: WebSocket | null;
  createdAt: number;
  senderConnected: boolean;
  receiverConnected: boolean;
}

export class TransferRoom extends DurableObject {
  private state: RoomState;
  private readonly TTL_MS: number = 1_800_000; // 30 minutes

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      code: "",
      senderSocket: null,
      receiverSocket: null,
      createdAt: Date.now(),
      senderConnected: false,
      receiverConnected: false,
    };
    // Schedule cleanup alarm
    ctx.storage.setAlarm(Date.now() + this.TTL_MS);
  }

  async alarm() {
    // TTL expired — close all sockets and clean up
    const expiredMsg = JSON.stringify({ type: "ROOM_EXPIRED" });
    this.state.senderSocket?.send(expiredMsg);
    this.state.receiverSocket?.send(expiredMsg);
    this.state.senderSocket?.close(1000, "Session expired");
    this.state.receiverSocket?.close(1000, "Session expired");
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role"); // "sender" | "receiver"
    const code = url.searchParams.get("code") ?? "";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);

    if (role === "sender") {
      this.state.senderSocket = server;
      this.state.senderConnected = true;
      this.state.code = code;
    } else if (role === "receiver") {
      if (!this.state.senderConnected) {
        server.close(4001, "Room not found");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.state.receiverSocket = server;
      this.state.receiverConnected = true;
      // Notify sender
      this.state.senderSocket?.send(JSON.stringify({ type: "PEER_JOINED" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    const isSender = ws === this.state.senderSocket;
    const target = isSender ? this.state.receiverSocket : this.state.senderSocket;

    // Relay OFFER, ANSWER, ICE_CANDIDATE directly to the other peer
    const relayTypes = ["OFFER", "ANSWER", "ICE_CANDIDATE"];
    if (relayTypes.includes(msg.type) && target) {
      target.send(message);
    }

    if (msg.type === "TRANSFER_COMPLETE") {
      // Relay to other peer — room stays open for subsequent files
      target?.send(JSON.stringify({ type: "TRANSFER_COMPLETE" }));
    }

    if (msg.type === "DISCONNECT") {
      // Sender is ending the session — notify receiver and tear down
      target?.send(JSON.stringify({ type: "DISCONNECT" }));
      await new Promise(r => setTimeout(r, 500));
      this.state.senderSocket?.close(1000, "Session ended");
      this.state.receiverSocket?.close(1000, "Session ended");
      await this.ctx.storage.deleteAll();
    }
  }

  async webSocketClose(ws: WebSocket) {
    const isSender = ws === this.state.senderSocket;
    const target = isSender ? this.state.receiverSocket : this.state.senderSocket;
    target?.send(JSON.stringify({
      type: "ERROR",
      error: { code: "PEER_DISCONNECTED", message: "The other peer disconnected." }
    }));
    target?.close(1000, "Peer disconnected");
  }
}
