# Floppy.cloud — Implementation Specification
**Repository:** github.com/padresb/floppycloud  
**Version:** 1.0  
**Architecture:** Peer-to-Peer WebRTC File Transfer  
**Infrastructure:** Cloudflare-native (Workers, Durable Objects, KV, Calls, R2, Pages)

---

## 1. Project Overview

Floppy.cloud is a no-login, browser-based file transfer application. A sender selects a file, receives a short transfer code, and shares that code with a recipient. The recipient enters the code and the file streams directly peer-to-peer via WebRTC data channels. No file is stored on any server. No user account is required.

### Core Principles
- Files travel directly between browsers — never stored on Cloudflare infrastructure during live transfer
- No authentication, no accounts, no cookies
- Rate limiting enforced by IP + transfer code to prevent abuse
- Async fallback: if the recipient is not online within the session window, the sender is notified and the session expires cleanly
- End-to-end encrypted in transit (DTLS-SRTP is built into WebRTC; additionally AES-256 client-side encryption is layered on top of the data channel)

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Vite + vanilla TypeScript | Fast, no framework overhead |
| Styling | Tailwind CSS v3 | Utility-first CSS |
| Deployment (frontend) | Cloudflare Pages | CDN-hosted static site |
| Signaling server | Cloudflare Workers (TypeScript) | WebSocket-based peer handshake |
| Session state | Cloudflare Durable Objects | Stateful per-session room |
| Rate limiting state | Cloudflare Workers KV | IP + code tracking |
| STUN/TURN | Cloudflare Calls (TURN API) | NAT traversal, relay fallback |
| Wrangler CLI | v3.x | Local dev + deployment tooling |
| Package manager | pnpm | Workspace management |
| Monorepo | pnpm workspaces | `/app` and `/worker` packages |

**Do not introduce:** React, Next.js, Express, Node.js servers, AWS/GCP services, or any database. The entire backend runs on Cloudflare Workers.

---

## 3. Repository Structure

```
floppycloud/
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── wrangler.toml                 # Cloudflare Worker config
├── .dev.vars                     # Local secrets (gitignored)
├── .env.example                  # Template for secrets
│
├── app/                          # Frontend (Cloudflare Pages)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.ts               # Entry point
│       ├── types.ts              # Shared TypeScript types
│       ├── styles/
│       │   └── global.css        # Tailwind directives + custom vars
│       ├── lib/
│       │   ├── webrtc.ts         # RTCPeerConnection management
│       │   ├── crypto.ts         # AES-256-GCM client-side encryption
│       │   ├── transfer.ts       # Chunked file send/receive logic
│       │   ├── signaling.ts      # WebSocket client for Worker
│       │   └── codes.ts          # Transfer code generation/validation
│       ├── ui/
│       │   ├── sender.ts         # Sender flow UI
│       │   ├── receiver.ts       # Receiver flow UI
│       │   ├── progress.ts       # Progress bar + status UI
│       │   └── toast.ts          # Error/status notifications
│       └── pages/
│           ├── home.ts           # Landing page (send or receive)
│           ├── send.ts           # Sender page
│           └── receive.ts        # Receiver page
│
└── worker/                       # Cloudflare Worker (signaling + rate limiting)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts              # Worker entry, routing
        ├── room.ts               # Durable Object: TransferRoom
        ├── ratelimit.ts          # Rate limiting logic (KV-backed)
        ├── turn.ts               # Cloudflare Calls TURN credential fetch
        ├── types.ts              # Shared Worker types
        └── utils.ts              # Code generation, helpers
```

---

## 4. Cloudflare Resource Configuration

### wrangler.toml

```toml
name = "floppycloud-worker"
main = "worker/src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[env.production]
routes = [{ pattern = "api.floppy.cloud/*", zone_name = "floppy.cloud" }]

[[durable_objects.bindings]]
name = "TRANSFER_ROOM"
class_name = "TransferRoom"

[[migrations]]
tag = "v1"
new_classes = ["TransferRoom"]

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<YOUR_KV_NAMESPACE_ID>"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<YOUR_KV_PREVIEW_NAMESPACE_ID>"
preview_id = "<YOUR_KV_PREVIEW_NAMESPACE_ID>"

[vars]
ENVIRONMENT = "production"
MAX_FILE_SIZE_MB = "2048"
SESSION_TTL_SECONDS = "600"
CHUNK_SIZE_BYTES = "65536"

# Secrets — set via: wrangler secret put <KEY>
# CF_CALLS_APP_ID
# CF_CALLS_APP_SECRET
# RATE_LIMIT_SECRET
```

### Required Cloudflare Resources to Create Before Development

1. **KV Namespace** — `wrangler kv:namespace create RATE_LIMIT_KV`
2. **Durable Object** — declared in wrangler.toml, auto-created on deploy
3. **Cloudflare Calls App** — create at dash.cloudflare.com → Calls → Create Application. Save App ID and Secret.
4. **Pages Project** — `wrangler pages project create floppycloud`
5. **Custom Domain** (optional for dev) — `floppy.cloud` pointed at Pages, `api.floppy.cloud` routed to Worker

---

## 5. Signaling Protocol

The signaling server uses WebSockets via Cloudflare Workers + Durable Objects. Each transfer session is a `TransferRoom` Durable Object instance keyed by the transfer code.

### WebSocket Message Schema

All messages are JSON. Both client and server use this envelope:

```typescript
// types.ts (shared)
type MessageType =
  | "CREATE_ROOM"       // Sender → Worker: create a session
  | "ROOM_CREATED"      // Worker → Sender: confirms code + ICE config
  | "JOIN_ROOM"         // Receiver → Worker: join by code
  | "PEER_JOINED"       // Worker → Sender: receiver connected
  | "OFFER"             // Sender → Worker → Receiver: SDP offer
  | "ANSWER"            // Receiver → Worker → Sender: SDP answer
  | "ICE_CANDIDATE"     // Either → Worker → Other: ICE candidate
  | "TRANSFER_COMPLETE" // Either peer → Worker: done signal
  | "ROOM_EXPIRED"      // Worker → Either: session TTL exceeded
  | "ERROR"             // Worker → Either: error with code

interface SignalMessage {
  type: MessageType;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}
```

### Signaling Flow

```
Sender                    Worker (DO)                 Receiver
  |                           |                           |
  |-- WS connect -----------> |                           |
  |-- CREATE_ROOM ----------> |                           |
  |<- ROOM_CREATED (code) --- |                           |
  |   (displays code to user) |                           |
  |                           | <--- WS connect --------- |
  |                           | <--- JOIN_ROOM (code) --- |
  |<- PEER_JOINED ----------- |                           |
  |-- OFFER (SDP) ----------> | --- OFFER ------------->  |
  |                           | <-- ANSWER -------------- |
  |<- ANSWER ---------------- |                           |
  |-- ICE_CANDIDATE --------> | --- ICE_CANDIDATE ----->  |
  |<- ICE_CANDIDATE --------- | <-- ICE_CANDIDATE ------- |
  |                           |                           |
  |======= Direct WebRTC Data Channel (P2P) ==============|
  |                           |                           |
  |-- TRANSFER_COMPLETE ----> |                           |
  |                           | --- TRANSFER_COMPLETE ->  |
  |                           | [DO self-destructs]       |
```

---

## 6. Durable Object: TransferRoom

**File:** `worker/src/room.ts`

```typescript
import { DurableObject } from "cloudflare:workers";

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
  private readonly TTL_MS: number = 600_000; // 10 minutes

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
      target?.send(JSON.stringify({ type: "TRANSFER_COMPLETE" }));
      // Brief delay then clean up
      await new Promise(r => setTimeout(r, 2000));
      ws.close(1000, "Transfer complete");
      target?.close(1000, "Transfer complete");
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
```

---

## 7. Worker Entry Point & Routing

**File:** `worker/src/index.ts`

```typescript
import { TransferRoom } from "./room";
import { checkRateLimit, recordRequest } from "./ratelimit";
import { getTurnCredentials } from "./turn";
import { generateCode } from "./utils";

export { TransferRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ENVIRONMENT === "production"
        ? "https://floppy.cloud"
        : "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- POST /api/rooms — Create a new transfer session ---
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const limited = await checkRateLimit(env, ip, "create", 10, 60); // 10 creates/min per IP
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const code = generateCode(); // e.g. "WOLF-7342"
      const id = env.TRANSFER_ROOM.idFromName(code);
      const stub = env.TRANSFER_ROOM.get(id);

      // Pre-warm the DO
      await stub.fetch(new Request(`https://room/init?code=${code}`));
      await recordRequest(env, ip, "create");

      return new Response(JSON.stringify({ code }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- GET /api/rooms/:code/ws — WebSocket upgrade (sender or receiver) ---
    if (request.method === "GET" && url.pathname.startsWith("/api/rooms/")) {
      const parts = url.pathname.split("/");
      const code = parts[3];
      const role = url.searchParams.get("role");

      if (!code || !role || !["sender", "receiver"].includes(role)) {
        return new Response("Bad request", { status: 400, headers: corsHeaders });
      }

      const limited = await checkRateLimit(env, ip, "ws", 30, 60); // 30 WS connections/min per IP
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const id = env.TRANSFER_ROOM.idFromName(code);
      const stub = env.TRANSFER_ROOM.get(id);
      return stub.fetch(new Request(
        `https://room/ws?role=${role}&code=${code}`,
        { headers: request.headers }
      ));
    }

    // --- GET /api/turn — Fetch ephemeral TURN credentials ---
    if (request.method === "GET" && url.pathname === "/api/turn") {
      const limited = await checkRateLimit(env, ip, "turn", 20, 60);
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const credentials = await getTurnCredentials(env);
      return new Response(JSON.stringify(credentials), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

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
```

---

## 8. Rate Limiting

**File:** `worker/src/ratelimit.ts`

Rate limiting is IP-based using Workers KV with sliding window counters. No authentication tokens. Three separate buckets: room creation, WebSocket connections, and TURN credential requests.

```typescript
import { Env } from "./index";

export async function checkRateLimit(
  env: Env,
  ip: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const key = `rl:${action}:${ip}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current) : 0;
  return count >= limit;
}

export async function recordRequest(
  env: Env,
  ip: string,
  action: string,
  windowSeconds: number = 60
): Promise<void> {
  const key = `rl:${action}:${ip}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current) : 0;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
    expirationTtl: windowSeconds * 2,
  });
}
```

### Rate Limit Table

| Action | Limit | Window | Bucket Key |
|---|---|---|---|
| POST /api/rooms (create session) | 10 | 60s per IP | `rl:create:{ip}:{window}` |
| GET /api/rooms/:code/ws (connect) | 30 | 60s per IP | `rl:ws:{ip}:{window}` |
| GET /api/turn (TURN credentials) | 20 | 60s per IP | `rl:turn:{ip}:{window}` |
| Global (all routes combined) | 100 | 60s per IP | `rl:global:{ip}:{window}` |

Add a global rate limit check at the top of the Worker fetch handler before routing.

---

## 9. TURN Credential Fetching

**File:** `worker/src/turn.ts`

Cloudflare Calls issues short-lived TURN credentials. Never expose the App Secret to the client — always fetch via the Worker.

```typescript
import { Env } from "./index";

interface TurnCredentials {
  iceServers: RTCIceServer[];
  ttl: number;
}

export async function getTurnCredentials(env: Env): Promise<TurnCredentials> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_CALLS_APP_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_CALLS_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }), // 24h credential TTL
    }
  );

  if (!response.ok) {
    throw new Error(`TURN credential fetch failed: ${response.status}`);
  }

  const data = await response.json() as { iceServers: RTCIceServer[] };

  // Always include public STUN as primary (free, no relay)
  return {
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      ...data.iceServers,
    ],
    ttl: 86400,
  };
}
```

---

## 10. Transfer Code Generation

**File:** `worker/src/utils.ts`

Codes are human-readable, 8 characters, format `WORD-NNNN`. Avoids ambiguous characters. Easy to read aloud.

```typescript
const WORDS = [
  "WOLF", "BEAR", "HAWK", "DUCK", "CRAB", "FROG", "LYNX", "MOTH",
  "DOVE", "MINK", "CROW", "WASP", "IBIS", "KITE", "NEWT", "PIKE",
  "VOLE", "WREN", "SLUG", "TOAD", "SEAL", "DART", "BOLT", "GUST",
  "TIDE", "DUNE", "COVE", "REEF", "MIST", "HAZE", "GLOW", "FLUX",
];

export function generateCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

export function isValidCode(code: string): boolean {
  return /^[A-Z]{3,5}-\d{4}$/.test(code);
}
```

---

## 11. Client-Side WebRTC & Transfer Logic

### lib/signaling.ts

```typescript
import type { SignalMessage } from "../types";

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, (payload: unknown) => void> = new Map();

  async connect(code: string, role: "sender" | "receiver"): Promise<void> {
    const wsBase = import.meta.env.VITE_API_URL.replace("https", "wss");
    this.ws = new WebSocket(`${wsBase}/api/rooms/${code}/ws?role=${role}`);

    return new Promise((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error("WebSocket connection failed"));
      this.ws!.onmessage = (e) => {
        const msg: SignalMessage = JSON.parse(e.data);
        this.handlers.get(msg.type)?.(msg.payload);
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
```

### lib/webrtc.ts

```typescript
import { SignalingClient } from "./signaling";

export async function getIceConfig(): Promise<RTCConfiguration> {
  const res = await fetch(`${import.meta.env.VITE_API_URL}/api/turn`);
  const { iceServers } = await res.json();
  return { iceServers, iceCandidatePoolSize: 10 };
}

export function createPeerConnection(
  config: RTCConfiguration,
  signaling: SignalingClient,
  onIceCandidate: (candidate: RTCIceCandidate) => void
): RTCPeerConnection {
  const pc = new RTCPeerConnection(config);

  pc.onicecandidate = (e) => {
    if (e.candidate) onIceCandidate(e.candidate);
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  return pc;
}
```

### lib/transfer.ts

Files are chunked and sent over a WebRTC data channel. A metadata packet is sent first, then binary chunks, then a completion marker.

```typescript
import { encryptChunk, decryptChunk } from "./crypto";

const CHUNK_SIZE = 65536; // 64KB chunks — balance between throughput and flow control

export interface TransferMetadata {
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  iv: string; // Base64 AES-GCM IV
}

export async function sendFile(
  file: File,
  dataChannel: RTCDataChannel,
  cryptoKey: CryptoKey,
  onProgress: (pct: number) => void
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const metadata: TransferMetadata = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks,
    iv: btoa(String.fromCharCode(...iv)),
  };

  // Wait for data channel to be open and buffer to be low
  await waitForChannelOpen(dataChannel);

  // Send metadata as JSON string first
  dataChannel.send(JSON.stringify({ type: "METADATA", payload: metadata }));

  const buffer = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const chunk = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const encrypted = await encryptChunk(new Uint8Array(chunk), cryptoKey, iv);

    // Simple flow control — wait if buffer is backing up
    while (dataChannel.bufferedAmount > CHUNK_SIZE * 8) {
      await new Promise(r => setTimeout(r, 10));
    }

    dataChannel.send(encrypted);
    onProgress(Math.round(((i + 1) / totalChunks) * 100));
  }

  dataChannel.send(JSON.stringify({ type: "TRANSFER_COMPLETE" }));
}

export async function receiveFile(
  dataChannel: RTCDataChannel,
  cryptoKey: CryptoKey,
  onMetadata: (meta: TransferMetadata) => void,
  onProgress: (pct: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let metadata: TransferMetadata | null = null;
    const chunks: ArrayBuffer[] = [];
    let received = 0;
    let iv: Uint8Array;

    dataChannel.onmessage = async (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.type === "METADATA") {
          metadata = msg.payload as TransferMetadata;
          iv = Uint8Array.from(atob(metadata.iv), c => c.charCodeAt(0));
          onMetadata(metadata);
        } else if (msg.type === "TRANSFER_COMPLETE" && metadata) {
          const blob = new Blob(chunks, { type: metadata.fileType });
          resolve(blob);
        }
      } else if (e.data instanceof ArrayBuffer && metadata) {
        const decrypted = await decryptChunk(new Uint8Array(e.data), cryptoKey, iv);
        chunks.push(decrypted.buffer);
        received++;
        onProgress(Math.round((received / metadata.totalChunks) * 100));
      }
    };

    dataChannel.onerror = (e) => reject(e);
  });
}

function waitForChannelOpen(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve) => { dc.onopen = () => resolve(); });
}
```

### lib/crypto.ts

```typescript
// AES-256-GCM client-side encryption
// Key is derived from a random passphrase embedded in the URL hash
// so the server never sees it

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importKeyFromBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptChunk(
  chunk: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunk);
}

export async function decryptChunk(
  chunk: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, chunk);
  return new Uint8Array(decrypted);
}
```

---

## 12. Sender & Receiver Flows

### Sender Flow (pages/send.ts)

1. User drags/drops or selects a file
2. Validate file size against `MAX_FILE_SIZE_MB` (default 2GB)
3. `POST /api/rooms` → receive `{ code }`
4. Generate AES-256 `CryptoKey`, export to Base64
5. Construct shareable link: `https://floppy.cloud/receive#code=WOLF-7342&key=<base64key>`
6. Display code prominently (`WOLF-7342`), display full link, show QR code
7. Open WebSocket as `sender` role
8. Wait for `PEER_JOINED` signal
9. Once receiver joins: create `RTCPeerConnection`, create data channel `"fileTransfer"`, create SDP offer, send via signaling
10. On `ANSWER`: set remote description
11. On `ICE_CANDIDATE`: add to peer connection
12. On data channel open: call `sendFile()`
13. On complete: show confirmation, option to send another

### Receiver Flow (pages/receive.ts)

1. Page loads, parse `#code=` and `#key=` from URL fragment (these never hit the server)
2. If fragment present: auto-fill code and proceed; otherwise show manual code entry UI
3. Import AES key from Base64 fragment
4. Open WebSocket as `receiver` role with the code
5. Create `RTCPeerConnection` with ICE config from `/api/turn`
6. On `OFFER`: set remote description, create answer, send via signaling
7. On `ICE_CANDIDATE`: add to peer connection
8. On data channel open: call `receiveFile()`
9. On `METADATA` message: show file name, size, type to user before download begins
10. On complete: auto-trigger browser download via `URL.createObjectURL(blob)`

---

## 13. URL Fragment Key Distribution

The encryption key is embedded in the URL fragment (the `#` portion). This is a deliberate security design: fragments are **never sent to any server** in HTTP requests, so the Worker, Cloudflare, and any proxy never sees the key.

The shareable link format is:
```
https://floppy.cloud/receive#code=WOLF-7342&key=<base64-aes-key>
```

The display-only short code (`WOLF-7342`) is for situations where the user wants to read a code aloud or type it manually — in this case the transfer proceeds **without** client-side encryption (the WebRTC DTLS layer still encrypts in transit, but not at rest). Make this distinction clear in the UI.

---

## 14. UI Design Specification

The UI should evoke retro computing nostalgia (floppy disks, early internet) while remaining clean and functional.

### Design Direction
- **Aesthetic:** Retro-terminal / early internet. Dark background, monospace fonts, pixel-style accents, subtle scanline texture
- **Color palette:**
  - Background: `#0D0D0D`
  - Surface: `#1A1A1A`
  - Accent: `#00FF87` (terminal green)
  - Secondary accent: `#FF6B35` (warm orange for warnings/errors)
  - Text: `#E8E8E8`
  - Muted: `#555`
- **Fonts:** `"Share Tech Mono"` (Google Fonts) for headings and codes; `"IBM Plex Mono"` for body text
- **Logo:** A pixel-art floppy disk SVG (3.5" disk, green label)

### Page Structure

**Home (`/`):**
- Centered layout, logo + tagline
- Two large click targets: "Send a file" / "Receive a file"
- Tagline: *"No login. No storage. Direct."*
- Small footer: transfer limits, session TTL info

**Send (`/send`):**
- Large drag-and-drop zone (dashed border, animated on hover)
- File selected state: show file name, size, type
- After room creation: large code display (`WOLF-7342`) with copy button
- QR code below the link (use `qrcode` npm package, rendered to canvas)
- Status bar: "Waiting for receiver…" → "Connected! Transferring…" → "Complete ✓"
- Animated progress bar during transfer (chunked %)

**Receive (`/receive`):**
- If arriving via full link (fragment present): auto-connect, show "Connecting to sender…"
- If arriving via code only: large text input for manual code entry, "Connect" button
- Pre-transfer confirmation: show file metadata (name, size, type) before accepting
- Progress bar during download
- On complete: large download button

---

## 15. Environment Variables

### .env.example (frontend — Vite)
```
VITE_API_URL=https://api.floppy.cloud
VITE_MAX_FILE_SIZE_MB=2048
VITE_SESSION_TTL_SECONDS=600
```

### .dev.vars (Worker secrets — local only, gitignored)
```
CF_CALLS_APP_ID=<your-cloudflare-calls-app-id>
CF_CALLS_APP_SECRET=<your-cloudflare-calls-app-secret>
```

---

## 16. Local Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create KV namespace for local dev (runs in-memory with Wrangler)
# No action needed — wrangler dev uses local KV automatically

# 3. Copy secrets file
cp .env.example app/.env.local
# Fill in VITE_API_URL=http://localhost:8787 for local dev

# 4. Start Worker locally
pnpm --filter worker dev
# Runs on http://localhost:8787

# 5. Start frontend in separate terminal
pnpm --filter app dev
# Runs on http://localhost:5173

# 6. Test WebRTC locally
# Open two browser tabs:
#   Tab 1: http://localhost:5173/send
#   Tab 2: http://localhost:5173/receive
```

### package.json (root)
```json
{
  "name": "floppycloud",
  "private": true,
  "scripts": {
    "dev": "concurrently \"pnpm --filter worker dev\" \"pnpm --filter app dev\"",
    "build": "pnpm --filter app build && pnpm --filter worker build",
    "deploy": "pnpm --filter worker deploy && pnpm --filter app deploy",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "concurrently": "^8.0.0"
  }
}
```

---

## 17. Deployment

```bash
# Deploy Worker
wrangler deploy

# Deploy frontend to Cloudflare Pages
pnpm --filter app build
wrangler pages deploy app/dist --project-name floppycloud

# Set production secrets
wrangler secret put CF_CALLS_APP_ID
wrangler secret put CF_CALLS_APP_SECRET
```

### Cloudflare Pages Configuration
- Build command: `pnpm --filter app build`
- Build output directory: `app/dist`
- Root directory: `/` (monorepo root)
- Environment variable: `VITE_API_URL` = `https://api.floppy.cloud`

---

## 18. File & Session Constraints

| Constraint | Value | Enforced By |
|---|---|---|
| Max file size | 2 GB | Client validation + data channel limit |
| Session TTL | 10 minutes | Durable Object alarm |
| Max concurrent sessions per IP | 5 | KV rate limiting |
| WebSocket connections per IP/min | 30 | Worker rate limiting |
| Room creation per IP/min | 10 | Worker rate limiting |
| TURN credential requests per IP/min | 20 | Worker rate limiting |
| Transfer code format | `WORD-NNNN` | Worker utils |
| Code expiry | Room TTL (10 min) | Durable Object |
| Encryption | AES-256-GCM (client) + DTLS-SRTP (WebRTC) | Browser Web Crypto API |

---

## 19. Error States & User Messaging

| Error | Code | User Message |
|---|---|---|
| Room not found | `ROOM_NOT_FOUND` | "That code doesn't match any active transfer. Check the code and try again." |
| Room expired | `ROOM_EXPIRED` | "This transfer session expired. Ask the sender to start a new one." |
| Peer disconnected | `PEER_DISCONNECTED` | "The connection was lost. Ask the sender to start a new transfer." |
| Rate limited | `RATE_LIMITED` | "Too many requests. Please wait a moment and try again." |
| File too large | `FILE_TOO_LARGE` | "Files must be under 2 GB." |
| WebRTC failed | `ICE_FAILED` | "Couldn't establish a direct connection. This can happen on strict networks." |
| Browser unsupported | `NO_WEBRTC` | "Your browser doesn't support WebRTC. Try Chrome, Firefox, or Edge." |

---

## 20. Future Enhancements (Out of Scope for v1)

- **Multi-file / folder transfer** — zip on the fly in-browser using fflate
- **R2 async fallback** — if receiver is offline, encrypt and store in R2 with a claim code; auto-delete on download or TTL
- **PIN protection** — optional 4-digit PIN on a room set by sender
- **Transfer history** — local-only (localStorage) log of sent/received files
- **Mobile app** — same Worker backend, Capacitor wrapper around the web app
- **Analytics** — Cloudflare Analytics Engine for aggregate transfer stats (no PII)

---

## Appendix: Key Dependencies

```json
// app/package.json dependencies
{
  "qrcode": "^1.5.3"
}

// app/package.json devDependencies
{
  "vite": "^5.0.0",
  "typescript": "^5.3.0",
  "tailwindcss": "^3.4.0",
  "autoprefixer": "^10.4.0",
  "postcss": "^8.4.0",
  "@cloudflare/workers-types": "^4.0.0"
}

// worker/package.json devDependencies
{
  "wrangler": "^3.0.0",
  "typescript": "^5.3.0",
  "@cloudflare/workers-types": "^4.0.0"
}
```

---

*Spec version 1.0 — Floppy.cloud — github.com/padresb/floppycloud*
