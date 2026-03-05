# Floppy.cloud — Implementation Specification
**Repository:** github.com/padresb/floppycloud  
**Version:** 1.0  
**Architecture:** Peer-to-Peer WebRTC File Transfer  
**Infrastructure:** Cloudflare-native (Workers, Durable Objects, KV, Calls, R2, Pages)

---

## 1. Project Overview

Floppy.cloud is a no-login, browser-based file transfer application. Any user lands on `floppy.cloud` and clicks **"Start Transfer"** — whoever clicks first becomes the sender and is assigned a unique two-word phrase (e.g. `golden-harbor`). Their shareable link is `https://floppy.cloud/golden-harbor#key=...`. They share that link via QR code, copy-paste, or by reading the two words aloud. The recipient opens the link or navigates to `floppy.cloud` and types the phrase manually. Once both peers are connected, **both screens display the same phrase prominently** so either party can verbally confirm they're on the right connection before any file is dropped. Files then stream directly peer-to-peer via WebRTC data channels. No file is ever stored on any server. No user account is required.

### Core Principles
- Files travel directly between browsers — never stored on Cloudflare infrastructure during live transfer
- No authentication, no accounts, no cookies
- Phrase is the room identifier AND the human-readable verification token — both peers see it on screen
- AES-256 encryption key travels only in the URL fragment (`#key=...`) — never sent to any server
- Rate limiting enforced by IP to prevent abuse and phrase brute-forcing
- Session ends when the sender explicitly disconnects — the link is permanently expired thereafter
- Inactivity TTL (30 min) as a safety net for abandoned sessions
- End-to-end encrypted in transit (DTLS-SRTP built into WebRTC) + AES-256-GCM client-side layer on top

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
│       │   └── phrase.ts         # Client-side phrase validation & display formatting
│       ├── ui/
│       │   ├── sender.ts         # Sender flow UI
│       │   ├── receiver.ts       # Receiver flow UI
│       │   ├── progress.ts       # Progress bar + status UI
│       │   └── toast.ts          # Error/status notifications
│       └── pages/
│           ├── home.ts           # Landing page (send or receive)
│           └── room.ts           # Room page (handles both sender & receiver roles)
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
preview_id = "<YOUR_KV_PREVIEW_NAMESPACE_ID>"

[vars]
ENVIRONMENT = "production"
MAX_FILE_SIZE_MB = "2048"
SESSION_TTL_SECONDS = "1800"
CHUNK_SIZE_BYTES = "65536"

# Secrets — set via: wrangler secret put <KEY>
# CF_CALLS_APP_ID
# CF_CALLS_APP_SECRET
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
  | "JOIN_ROOM"         // Receiver → Worker: join by code (unused in WS — receiver connects by URL path)
  | "PEER_JOINED"       // Worker → Sender: receiver connected
  | "OFFER"             // Sender → Worker → Receiver: SDP offer
  | "ANSWER"            // Receiver → Worker → Sender: SDP answer
  | "ICE_CANDIDATE"     // Either → Worker → Other: ICE candidate
  | "TRANSFER_COMPLETE" // Sender → Worker → Receiver: one file done
  | "DISCONNECT"        // Sender → Worker → Receiver: session ending, link expired
  | "ROOM_EXPIRED"      // Worker → Either: inactivity TTL exceeded
  | "ERROR"             // Worker → Either: error with code

interface SignalMessage {
  type: MessageType;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}
```

### Signaling Flow

```
  REST (pre-WS)             Worker (DO)                 Receiver
  |                           |                           |
  |-- POST /api/rooms ------> | (creates room, returns    |
  |<- { phrase } ------------ |  phrase to sender)        |
  |                           |                           |
Sender                        |                           |
  |-- WS connect (/phrase) -> |                           |
  |   role=sender             |                           |
  |                           | <--- WS connect --------- |
  |                           |      role=receiver        |
  |<- PEER_JOINED ----------- |                           |
  |-- OFFER (SDP) ----------> | --- OFFER ------------->  |
  |                           | <-- ANSWER -------------- |
  |<- ANSWER ---------------- |                           |
  |-- ICE_CANDIDATE --------> | --- ICE_CANDIDATE ----->  |
  |<- ICE_CANDIDATE --------- | <-- ICE_CANDIDATE ------- |
  |                           |                           |
  |======= Direct WebRTC Data Channel (P2P) ==============|
  |                           |                           |
  |-- TRANSFER_COMPLETE ----> | --- TRANSFER_COMPLETE ->  | (one file done, room stays open)
  |   (repeat for more files) |                           |
  |-- DISCONNECT -----------> | --- DISCONNECT -------->  |
  |                           | [DO tears down, link      |
  |                           |  permanently expired]     |
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
```

---

## 7. Worker Entry Point & Routing

**File:** `worker/src/index.ts`

```typescript
import { TransferRoom } from "./room";
import { checkRateLimit, recordRequest } from "./ratelimit";
import { getTurnCredentials } from "./turn";
import { generatePhrase, isValidPhrase } from "./utils";

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

      const phrase = generatePhrase(); // e.g. "golden-harbor"
      // Validate phrase format as defense-in-depth
      if (!isValidPhrase(phrase)) return new Response("Invalid phrase", { status: 400 });
      const id = env.TRANSFER_ROOM.idFromName(phrase);
      const stub = env.TRANSFER_ROOM.get(id);
      await recordRequest(env, ip, "create");

      return new Response(JSON.stringify({ phrase }), {
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

## 10. Phrase Generation

**File:** `worker/src/utils.ts`

Phrases are exactly **two lowercase words** separated by a single hyphen: `adjective-noun` (e.g. `golden-harbor`, `silent-ridge`, `copper-tide`). Wordlists of ~1,024 adjectives × ~1,024 nouns give approximately **1 million combinations**. With 30-minute session TTLs and rate limiting at 10 room creations per IP per minute, brute-forcing is computationally impractical. No numbers — spoken phrases should be clean and unambiguous ("golden harbor", not "golden harbor four eight two").

Words are chosen to be: unambiguous when spoken aloud, phonetically distinct from each other, free of offensive combinations (curated list), and concrete/visual so they're memorable.

The phrase IS the URL path: `floppy.cloud/golden-harbor` — no query parameters needed for routing. The AES key travels only in the fragment: `floppy.cloud/golden-harbor#key=<base64>`.

```typescript
const ADJECTIVES = [
  "amber", "ancient", "arctic", "autumn", "azure", "blazing", "bold",
  "calm", "cedar", "coastal", "cobalt", "copper", "coral", "cosmic",
  "crimson", "crystal", "curious", "dappled", "dawn", "deep", "desert",
  "distant", "drifting", "dusk", "dusty", "electric", "emerald", "empty",
  "endless", "faded", "fallen", "fern", "fierce", "floating", "foggy",
  "forest", "frosted", "gentle", "gilded", "glacial", "golden", "granite",
  "gravel", "hollow", "horizon", "humble", "indigo", "inland", "iron",
  "ivory", "jade", "jagged", "jasper", "kind", "lavender", "leafy",
  "lemon", "lunar", "marble", "meadow", "misty", "mossy", "narrow",
  "noble", "northern", "obsidian", "ocean", "olive", "onyx", "opal",
  "pale", "patient", "pearl", "pebble", "pine", "plain", "polar",
  "quiet", "radiant", "ragged", "rapid", "raven", "remote", "rocky",
  "rosy", "rough", "russet", "rustic", "sable", "sacred", "saffron",
  "sandy", "sapphire", "scarlet", "serene", "shaded", "shallow", "silver",
  "slate", "slow", "smoky", "snowy", "solar", "somber", "sparse",
  "starlit", "steady", "steep", "still", "stony", "stormy", "sudden",
  "summer", "sunlit", "swift", "tangerine", "teal", "timber", "twilight",
  "upper", "vast", "velvet", "verdant", "violet", "vivid", "wandering",
  "warm", "weathered", "wide", "wild", "winter", "wispy", "wooden",
  "yellow", "zealous", "zenith", "zephyr",
];

const NOUNS = [
  "anchor", "anvil", "apex", "arch", "arrow", "atlas", "bay", "beacon",
  "birch", "blade", "bluff", "boulder", "bridge", "brook", "buoy",
  "cabin", "canopy", "canyon", "cape", "cedar", "channel", "cliff",
  "cloud", "coast", "compass", "cove", "crater", "creek", "crest",
  "delta", "depot", "dune", "eagle", "ember", "falcon", "fern",
  "ferry", "field", "flint", "forge", "fountain", "fox", "gale",
  "gate", "glacier", "gorge", "granite", "grove", "gulf", "harbor",
  "haven", "hawk", "heath", "helm", "heron", "hill", "hollow",
  "horizon", "inlet", "island", "kelp", "keystone", "lagoon", "lantern",
  "larch", "ledge", "lighthouse", "linden", "lodge", "loft", "maple",
  "marsh", "meadow", "mesa", "mill", "mist", "moon", "moor",
  "moss", "moth", "mountain", "narrows", "needle", "nest", "oak",
  "oar", "orbit", "osprey", "outpost", "owl", "peak", "pebble",
  "pier", "pilot", "pine", "pinnacle", "plain", "plateau", "plover",
  "pond", "portal", "prairie", "prism", "quarry", "quartz", "raven",
  "reef", "ridge", "river", "robin", "rock", "rook", "runnel",
  "saddle", "sage", "sail", "salmon", "sandbar", "shelf", "shore",
  "signal", "slope", "snipe", "source", "spar", "spit", "spruce",
  "starling", "stone", "storm", "summit", "swallow", "swift", "talon",
  "thistle", "thorn", "tide", "timber", "torch", "tower", "trail",
  "tundra", "vale", "valley", "vault", "vessel", "vole", "wave",
  "waypoint", "weir", "willow", "wind", "wolf", "wood", "wren",
];

export function generatePhrase(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

export function isValidPhrase(phrase: string): boolean {
  // Matches lowercase adjective-noun format, 6–40 chars
  return /^[a-z]+-[a-z]+$/.test(phrase) && phrase.length >= 6 && phrase.length <= 40;
}

// Display helper — capitalises each word for on-screen verification badge
export function formatPhraseForDisplay(phrase: string): string {
  return phrase
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" · ");
  // e.g. "Golden · Harbor"
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

  async connect(phrase: string, role: "sender" | "receiver"): Promise<void> {
    const wsBase = import.meta.env.VITE_API_URL.replace("https", "wss");
    this.ws = new WebSocket(`${wsBase}/api/rooms/${phrase}/ws?role=${role}`);

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

### Sender Flow (pages/room.ts — sender role)

The sender never selects a file first. The link is the starting point.

**Phase 1 — Link Generation (immediate on page load):**
1. Page loads → automatically `POST /api/rooms` → receive `{ phrase }`
2. Generate AES-256 `CryptoKey`, export to Base64
3. Construct shareable link: `https://floppy.cloud/golden-harbor#key=<base64key>`
4. Store phrase in `sessionStorage` as `floppycloud_owned_phrase` — marks this tab as the sender
5. Open WebSocket as `sender` role
6. Display the shareable link with copy button and QR code
7. Show connection status: **unlocked padlock icon, grey/amber** — "Waiting for receiver…"

**Phase 2 — Receiver Joins (live state):**
7. On `PEER_JOINED` signal: initiate WebRTC handshake (create `RTCPeerConnection`, data channel `"fileTransfer"`, SDP offer)
8. On `ANSWER` + ICE exchange complete: P2P connection established
9. Transition status indicator to: **locked padlock icon, green** — "Connected — encrypted"
10. Reveal file transfer UI (drag/drop zone + file picker button) — this UI is hidden until live

**Phase 3 — Transfer:**
11. User selects or drops a file — validate size ≤ `MAX_FILE_SIZE_MB`
12. Call `sendFile()` — show animated transfer progress
13. On complete: show "✓ Sent" confirmation
14. Return to file drop zone — sender can immediately drop another file (repeat Phase 3)
15. "Disconnect" button always visible while live — terminates session

**Phase 4 — Disconnect:**
16. Sender clicks Disconnect (or closes tab)
17. Send `DISCONNECT` signal → Worker closes room → receiver notified
18. Room is destroyed. Link is permanently expired.

---

### Receiver Flow (pages/room.ts — receiver role)

1. Receiver opens the shareable link `floppy.cloud/golden-harbor#key=...` OR navigates to home and types the two-word phrase manually
2. Phrase is read from `window.location.pathname`. AES key is parsed from `window.location.hash` (never sent to any server — if absent, transport-only encryption mode)
3. Import AES key from Base64 fragment
4. Open WebSocket as `receiver` role — Worker notifies sender via `PEER_JOINED`
5. Create `RTCPeerConnection`, exchange SDP + ICE via signaling
6. On P2P connection established: show **locked padlock, green** — "Connected — encrypted"
7. Receiver waits — the sender drives all file transfers
8. On incoming data channel `METADATA` message: show file name + size ("Receiving: report.pdf — 4.2 MB")
9. Animated progress bar during receive
10. On `TRANSFER_COMPLETE`: auto-trigger browser download via `URL.createObjectURL(blob)` + show "✓ Saved"
11. Receiver stays connected — more files may arrive (repeat 8–10)
12. On `DISCONNECT` from sender or `ROOM_EXPIRED`: show "Session ended — this link has expired"

---

## 13. URL Structure & Key Distribution

### Shareable Link Format
```
https://floppy.cloud/golden-harbor#key=<base64-aes-256-key>
```

- **Path** (`/golden-harbor`) — the two-word phrase, used as the room identifier by the Worker. Sent to the server as a normal HTTP path segment.
- **Fragment** (`#key=...`) — the AES-256-GCM encryption key. **Never sent to any server** by the browser. The Worker, Cloudflare edge, and any network proxy are blind to it.

### Routing Logic

Cloudflare Pages serves a single `index.html` for all routes (SPA routing). The frontend JS inspects `window.location.pathname` on load:

| Path pattern | Action |
|---|---|
| `/` | Home page — show "Start Transfer" CTA + manual phrase entry field |
| `/{valid-phrase}` | Room page — determine role (see below), connect to Worker |
| anything else | 404 page |

### Role Determination on the Room Page

When a user lands on `/{phrase}`:
1. Check `sessionStorage` for `floppycloud_owned_phrase` matching the current phrase
2. If match found → **sender role** (they created this room moments ago)
3. If no match → **receiver role** (they arrived via link or typed the phrase)

`sessionStorage` is tab-scoped and never persists across sessions, so there is no cross-contamination.

### Manual Phrase Entry (receiver without a link)

On the home page `/`, below the "Start Transfer" button, there is a secondary input:
```
[ golden · harbor  ▸ Connect ]
```
The receiver types the phrase they heard verbally, hits Connect, and is navigated to `/{phrase}`. The AES key will not be present in the fragment in this case — the transfer still proceeds via DTLS-SRTP (WebRTC's built-in encryption), but the additional AES-256-GCM client-side layer is skipped. The UI surfaces this distinction clearly: the padlock badge reads "Encrypted (transport)" rather than "End-to-end encrypted" when no key fragment is present.

### Phrase as Verification Token

Once the P2P connection is established, **both the sender and receiver screens display the phrase in a prominent badge**:

```
🔒  Golden · Harbor
```

Either party can read this aloud to the other and confirm it matches before sending anything sensitive. This is the out-of-band verification step — analogous to Signal's safety numbers but human-friendly.

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
- Centered layout, logo + tagline: *"No login. No storage. Direct."*
- **Primary CTA:** Large "Start Transfer" button — clicking creates a room immediately, generates a phrase, and navigates the sender to `/{phrase}`
- **Secondary input** (below the CTA, lower visual weight): a phrase entry field + "Connect" button for recipients who were given the phrase verbally
  - Placeholder text: `golden · harbor`
  - On submit: navigate to `/{phrase}` as receiver
- Footer: "How it works" — 3 steps, session limit info

**Room Page (`/{phrase}` — used by BOTH sender and receiver):**

Role is determined by `sessionStorage` (see Section 13). The page layout is identical for both roles; only the status text and active controls differ.

*State 1 — Waiting (sender: waiting for receiver to join):*
- Phrase displayed prominently at the top in a styled badge: `Golden · Harbor`
- Shareable link in a copy-able input field below the phrase
- QR code alongside the link (renders the full URL including `#key=` fragment)
- **Unlocked padlock icon, pulsing amber** — "Waiting for receiver…"
- File drop zone visible but dimmed/disabled — tooltip: "Waiting for receiver to connect"
- Small "Cancel session" link

*State 1 — Waiting (receiver: connecting to room):*
- Phrase badge displayed: `Golden · Harbor`  
- Spinner — "Connecting…"
- Once WebSocket connects and P2P handshake begins: "Establishing secure connection…"

*State 2 — Live (P2P established, both peers):*
- Padlock **snaps locked, turns solid green** — CSS transition, slight scale bounce
- Badge updates: 🔒 `Golden · Harbor` — the phrase is the visual anchor confirming both parties are on the same session
- Status: "Connected · End-to-end encrypted" (or "Connected · Encrypted (transport)" if no key fragment)
- **Sender:** file drop zone activates — animated dashed border, full opacity. "Drag & drop a file, or click to select."
- **Receiver:** "Waiting for sender to drop a file…" — passive waiting state
- "End Session" button visible to sender (prominent); receiver sees "Leave" (less prominent)

*State 3 — Transferring (sender):*
- File name + size above the progress bar
- Animated progress bar (chunked %, left to right fill)
- Transfer speed displayed ("4.2 MB/s")
- Padlock stays green throughout
- On complete: "✓ Sent" flash → drop zone immediately reactivates for next file

*State 3 — Receiving (receiver):*
- File name + size appear as soon as `METADATA` arrives
- Same animated progress bar style
- On complete: browser download triggers automatically via `URL.createObjectURL` + large "✓ Saved" confirmation
- Returns to passive waiting state for next file

*State 4 — Session Ended:*
- Padlock becomes grey, unlocked
- Badge greys out
- Message: "This session has ended — the link has expired"
- Phrase is struck through visually to signal it cannot be reused
- CTA: "Start a new transfer" → home page

---

## 15. Environment Variables

### .env.example (frontend — Vite)
```
VITE_API_URL=https://api.floppy.cloud
VITE_MAX_FILE_SIZE_MB=2048
VITE_SESSION_TTL_SECONDS=1800
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
#   Tab 1: http://localhost:5173  → click "Start Transfer" → copy the generated link
#   Tab 2: paste the generated link (or open http://localhost:5173/golden-harbor as receiver)
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
| Session TTL (inactivity) | 30 minutes | Durable Object alarm (safety net only) |
| Session end (primary) | Sender disconnects | `DISCONNECT` signal + DO cleanup |
| Max concurrent sessions per IP | 5 | KV rate limiting |
| WebSocket connections per IP/min | 30 | Worker rate limiting |
| Room creation per IP/min | 10 | Worker rate limiting |
| TURN credential requests per IP/min | 20 | Worker rate limiting |
| Phrase format | `adjective-noun` (e.g. `golden-harbor`) — no numbers | Worker utils |
| Link reuse after disconnect | Not permitted — link is permanently expired | Durable Object |
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
