import type { SignalMessage } from "../types";

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, (payload: unknown) => void> = new Map();

  async connect(phrase: string, role: "sender" | "receiver"): Promise<void> {
    const apiUrl: string = import.meta.env.VITE_API_URL ?? "";
    const wsBase = apiUrl.replace("https", "wss").replace("http", "ws");
    this.ws = new WebSocket(
      `${wsBase}/api/rooms/${phrase}/ws?role=${role}`
    );

    return new Promise((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () =>
        reject(new Error("WebSocket connection failed"));
      this.ws!.onmessage = (e) => {
        const msg: SignalMessage = JSON.parse(e.data);
        if (msg.type === "ERROR") {
          this.handlers.get("ERROR")?.(msg.error ?? msg.payload);
        } else {
          this.handlers.get(msg.type)?.(msg.payload);
        }
        this.handlers.get("*")?.(msg);
      };
      this.ws!.onclose = (e) => {
        this.handlers.get("CLOSE")?.(e);
      };
    });
  }

  on(type: string, handler: (payload: unknown) => void) {
    this.handlers.set(type, handler);
  }

  send(type: string, payload?: unknown) {
    this.ws?.send(JSON.stringify({ type, payload }));
  }

  disconnect() {
    this.ws?.close();
  }
}
