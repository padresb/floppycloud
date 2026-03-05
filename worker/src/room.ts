import { DurableObject } from "cloudflare:workers";
import { Env } from "./types";

export class TransferRoom extends DurableObject {
  private readonly TTL_MS: number = 1_800_000;  // 30 min — waiting for first connection
  private readonly IDLE_TTL_MS: number = 600_000; // 10 min — idle after connection/transfer
  private senderConnected = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schedule cleanup alarm
    ctx.storage.setAlarm(Date.now() + this.TTL_MS);
  }

  async alarm() {
    const expiredMsg = JSON.stringify({ type: "ROOM_EXPIRED" });
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(expiredMsg);
      ws.close(1000, "Session expired");
    }
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const code = url.searchParams.get("code") ?? "";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (role === "sender") {
      this.ctx.acceptWebSocket(server, ["sender"]);
      this.senderConnected = true;
    } else if (role === "receiver") {
      // Check if a sender is connected
      const senders = this.ctx.getWebSockets("sender");
      if (senders.length === 0 && !this.senderConnected) {
        server.close(4001, "Room not found");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server, ["receiver"]);
      // Switch to idle TTL now that both peers are connected
      await this.ctx.storage.setAlarm(Date.now() + this.IDLE_TTL_MS);
      // Notify sender
      for (const ws of this.ctx.getWebSockets("sender")) {
        ws.send(JSON.stringify({ type: "PEER_JOINED" }));
      }
    } else {
      server.close(4002, "Invalid role");
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message as string);
    const tags = this.ctx.getTags(ws);
    const isSender = tags.includes("sender");
    const targetTag = isSender ? "receiver" : "sender";
    const targets = this.ctx.getWebSockets(targetTag);

    // Relay OFFER, ANSWER, ICE_CANDIDATE directly to the other peer
    const relayTypes = ["OFFER", "ANSWER", "ICE_CANDIDATE"];
    if (relayTypes.includes(msg.type)) {
      for (const target of targets) {
        target.send(message as string);
      }
    }

    if (msg.type === "TRANSFER_COMPLETE") {
      for (const target of targets) {
        target.send(JSON.stringify({ type: "TRANSFER_COMPLETE" }));
      }
      // Restart idle timer — 10 more minutes for next file
      await this.ctx.storage.setAlarm(Date.now() + this.IDLE_TTL_MS);
    }

    if (msg.type === "DISCONNECT") {
      for (const target of targets) {
        target.send(JSON.stringify({ type: "DISCONNECT" }));
      }
      await new Promise(r => setTimeout(r, 500));
      for (const w of this.ctx.getWebSockets()) {
        w.close(1000, "Session ended");
      }
      await this.ctx.storage.deleteAll();
    }
  }

  async webSocketClose(ws: WebSocket) {
    const tags = this.ctx.getTags(ws);
    const isSender = tags.includes("sender");
    const targetTag = isSender ? "receiver" : "sender";
    const targets = this.ctx.getWebSockets(targetTag);

    for (const target of targets) {
      target.send(JSON.stringify({
        type: "ERROR",
        error: { code: "PEER_DISCONNECTED", message: "The other peer disconnected." }
      }));
      target.close(1000, "Peer disconnected");
    }
  }
}
