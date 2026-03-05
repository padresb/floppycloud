# Floppy.cloud — Infrastructure & Stack Reference

This document describes every service, binding, variable, route, and relationship in the Floppy.cloud stack. It is intended as a complete map for operational reference and as input for architecture diagrams or infographics.

---

## Repository

```
Type:       Monorepo
Manager:    pnpm workspaces
Packages:   app/  (frontend)
            worker/  (backend)
```

---

## Cloudflare Services Used

| Service | Purpose | Free Tier Limit |
|---|---|---|
| Cloudflare Pages | Hosts the frontend SPA | Unlimited requests |
| Cloudflare Workers | API + signaling backend | 100,000 req/day |
| Durable Objects | Per-session WebSocket broker | 100,000 req/day |
| Workers KV | IP-based rate limit counters | 100,000 reads/day, 1,000 writes/day |
| Cloudflare Calls (TURN) | WebRTC relay fallback | 1,000 GB/month |

---

## Frontend — Cloudflare Pages

```
Project name:   floppycloud
Deploy source:  app/dist  (built via Vite)
Domain:         floppy.cloud  (and www.floppy.cloud)
Build command:  tsc && vite build
Output dir:     app/dist
```

### Build Toolchain

| Tool | Version | Role |
|---|---|---|
| Vite | ^5.0.0 | Bundler / dev server |
| TypeScript | ^5.3.0 | Type checking + compilation |
| Tailwind CSS | ^3.4.0 | Utility CSS framework |
| PostCSS + Autoprefixer | ^8.4.0 / ^10.4.0 | CSS processing |
| qrcode | ^1.5.3 | QR code generation for share link |

### Frontend Environment Variables (Vite)

| Variable | Default | Set In | Purpose |
|---|---|---|---|
| `VITE_API_URL` | `http://localhost:8787` | `.env.development` | Worker base URL |
| `VITE_MAX_FILE_SIZE_MB` | `2048` | `.env` / build env | Client-side file size validation |

### URL Routes (SPA — client-side router in `app/src/main.ts`)

| Path | Page | Description |
|---|---|---|
| `/` | Home | Create session or enter phrase to receive |
| `/{phrase}` | Room | Sender or receiver view (determined by `sessionStorage`) |
| `/{phrase}#key={base64}` | Room (full link) | Receiver with encryption key in fragment |
| `/*` (invalid) | 404 | Catch-all for unrecognized paths |

### Frontend Pages (`app/src/pages/`)

| File | View | Role |
|---|---|---|
| `home.ts` | Home page | Creates room (POST /api/rooms), accepts phrase input for receivers |
| `room.ts` | Room page | Orchestrates sender and receiver WebRTC + transfer logic |

### Frontend Libraries (`app/src/lib/`)

| File | Purpose |
|---|---|
| `crypto.ts` | AES-256-GCM key generation, encrypt/decrypt, base64 import/export |
| `webrtc.ts` | RTCPeerConnection creation, ICE config fetch, ICE restart |
| `signaling.ts` | WebSocket client wrapping the worker signaling API |
| `transfer.ts` | File chunking (64 KB), encrypted send, ordered receive |
| `phrase.ts` | Phrase validation regex, display formatting |

### Frontend UI Components (`app/src/ui/`)

| File | Purpose |
|---|---|
| `sender.ts` | Sender UI state machine (waiting → peer joined → channel ready → transferring → complete) |
| `receiver.ts` | Receiver UI state machine (connecting → connected → receiving → complete) |
| `progress.ts` | Progress bar component |
| `toast.ts` | Toast notification system |

---

## Backend — Cloudflare Worker

```
Worker name:    floppycloud
Entry point:    worker/src/index.ts
Route:          api.floppy.cloud/*  (zone: floppy.cloud)
Compatibility:  2024-11-01  +  nodejs_compat flag
Config file:    worker/wrangler.toml
```

### Worker Dependencies

| Package | Version | Role |
|---|---|---|
| wrangler | ^4.0.0 | CLI / deployment tool |
| @cloudflare/workers-types | ^4.0.0 | TypeScript types for Workers runtime |
| typescript | ^5.3.0 | Type checking |

### API Endpoints (`worker/src/index.ts`)

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/rooms` | Create a new transfer session, returns `{ phrase }` | 10/min/IP |
| `GET` | `/api/rooms/:phrase/ws?role=sender` | WebSocket upgrade — sender joins room | 30/min/IP |
| `GET` | `/api/rooms/:phrase/ws?role=receiver` | WebSocket upgrade — receiver joins room | 30/min/IP |
| `GET` | `/api/turn` | Returns ephemeral TURN credentials (ICE config) | 20/min/IP |
| All | All | Global request gate | 100/min/IP |

### Worker Environment Variables (`[vars]` in wrangler.toml)

| Variable | Value | Purpose |
|---|---|---|
| `ENVIRONMENT` | `"production"` | Controls CORS (strict in production, `*` in dev) |
| `MAX_FILE_SIZE_MB` | `"2048"` | Reference value (2 GB) |
| `SESSION_TTL_SECONDS` | `"1800"` | Reference value (30 min pre-connect TTL) |
| `CHUNK_SIZE_BYTES` | `"65536"` | Reference value (64 KB chunks) |

### Worker Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `CF_CALLS_APP_ID` | Cloudflare Calls app ID for TURN credential generation |
| `CF_CALLS_APP_SECRET` | Cloudflare Calls app secret for TURN credential generation |

### CORS Policy (`worker/src/index.ts`)

| Environment | Allowed Origins |
|---|---|
| production | `https://floppy.cloud`, `https://www.floppy.cloud` |
| non-production | `*` |

Headers: `Access-Control-Allow-Methods: GET, POST, OPTIONS` · `Vary: Origin`

---

## Durable Object — TransferRoom

```
Binding name:   TRANSFER_ROOM
Class:          TransferRoom
Storage:        SQLite (new_sqlite_classes migration tag: v1)
File:           worker/src/room.ts
```

### Responsibilities

- Accepts WebSocket connections from sender and receiver
- Relays WebRTC signaling messages (OFFER, ANSWER, ICE_CANDIDATE)
- Manages session TTL via Cloudflare alarm
- Cleans up storage on expiry or disconnect

### Session Lifecycle / TTL

| Event | Alarm Set To |
|---|---|
| Room created (DO constructed) | Now + 30 minutes |
| Receiver connects | Now + 10 minutes |
| `TRANSFER_COMPLETE` received | Now + 10 minutes |
| Sender or receiver disconnects | Immediate cleanup (no alarm needed) |

### WebSocket Message Types (relayed through DO)

| Type | Direction | Description |
|---|---|---|
| `PEER_JOINED` | DO → Sender | Receiver has connected |
| `OFFER` | Sender → Receiver | WebRTC SDP offer |
| `ANSWER` | Receiver → Sender | WebRTC SDP answer |
| `ICE_CANDIDATE` | Either → Other | ICE candidate exchange |
| `TRANSFER_COMPLETE` | Sender → Receiver | File transfer finished |
| `DISCONNECT` | Either → Other | Intentional session end |
| `ROOM_EXPIRED` | DO → Both | TTL alarm fired |
| `ERROR` (PEER_DISCONNECTED) | DO → Remaining | Other peer dropped unexpectedly |

---

## KV Namespace — RATE_LIMIT_KV

```
Binding name:   RATE_LIMIT_KV
KV namespace ID: ba272f9b18634bc58c4a7ddb35a0eb79
File:           worker/src/ratelimit.ts
Key format:     rl:{action}:{ip}:{timeWindow}
TTL:            2× window length (auto-expires)
```

### Rate Limit Actions & Thresholds (hardcoded in `worker/src/index.ts`)

| Action key | Limit | Window | index.ts line |
|---|---|---|---|
| `global` | 100 req | 60 sec | 41 |
| `create` | 10 req | 60 sec | 49 |
| `ws` | 30 req | 60 sec | 72 |
| `turn` | 20 req | 60 sec | 86 |

---

## Cloudflare Calls — TURN Relay

```
API endpoint:   https://rtc.live.cloudflare.com/v1/turn/keys/{CF_CALLS_APP_ID}/credentials/generate
Credential TTL: 24 hours
File:           worker/src/turn.ts
Free tier:      1,000 GB/month relayed
Overage cost:   $0.05/GB
```

TURN is a fallback only. Direct P2P is always attempted first via ICE. A TURN relay indicator is shown in the sender UI when relay is active (detected via `pc.getStats()` candidate type `"relay"`).

---

## Data Flow

### 1. Session Creation
```
Browser (sender)
  → POST api.floppy.cloud/api/rooms
  → Worker checks rate limits (KV read+write)
  → Worker calls generatePhrase()
  → Returns { phrase: "golden-harbor" }
  → Browser generates AES-256-GCM key
  → URL updated to /golden-harbor#key={base64}
  → Share link + QR code displayed
```

### 2. ICE / TURN Config Fetch
```
Browser (sender or receiver)
  → GET api.floppy.cloud/api/turn
  → Worker fetches credentials from Cloudflare Calls API
    (using CF_CALLS_APP_ID + CF_CALLS_APP_SECRET secrets)
  → Returns ICE server list with STUN + TURN credentials
  → Browser uses config to create RTCPeerConnection
```

### 3. Signaling / WebRTC Handshake
```
Sender   → GET /api/rooms/golden-harbor/ws?role=sender  → DO (WebSocket)
Receiver → GET /api/rooms/golden-harbor/ws?role=receiver → DO (WebSocket)
DO       → sends PEER_JOINED to sender

Sender   → creates RTCPeerConnection + data channel
Sender   → sends OFFER  → DO → Receiver
Receiver → sends ANSWER → DO → Sender
Both     → exchange ICE_CANDIDATE via DO

WebRTC data channel established (DTLS-SRTP encrypted, P2P or via TURN)
```

### 4. Key Exchange
```
Sender   → sends KEY_RELAY { key: base64 } as first data channel message
Receiver (full URL):  ignores key in message, uses #key= from URL fragment
Receiver (phrase only): imports key from KEY_RELAY message
Both     → now hold same AES-256-GCM CryptoKey in browser memory
```

### 5. File Transfer
```
Sender   → sends METADATA JSON { fileName, fileSize, totalChunks, iv }
Sender   → sends encrypted binary chunks (64 KB each, AES-256-GCM)
           (flow control: pauses if bufferedAmount > 8 × 64 KB)
Receiver → decrypts chunks in strict wire order (promise chain)
Sender   → sends TRANSFER_COMPLETE JSON
Sender   → sends TRANSFER_COMPLETE via signaling WebSocket (DO)
DO       → resets idle TTL alarm to now + 10 min
Receiver → assembles Blob, triggers browser download
```

---

## Security Model

| Layer | Mechanism | What it protects against |
|---|---|---|
| Transport | DTLS-SRTP (WebRTC native) | Network eavesdropping on data channel |
| Application (full link) | AES-256-GCM, key in URL fragment only | Server compromise, TURN relay inspection |
| Application (phrase only) | AES-256-GCM, key via DTLS-SRTP data channel | Server compromise (key not in signaling) |
| Signaling server | Never receives key or file data | Server-side key exposure |
| URL fragment | Not sent in HTTP requests | Key never reaches any server |

---

## Deployment Commands

```bash
# Worker
wrangler deploy

# Frontend
pnpm --filter app build
wrangler pages deploy app/dist --project-name floppycloud

# Both
pnpm deploy

# Secrets
wrangler secret put CF_CALLS_APP_ID
wrangler secret put CF_CALLS_APP_SECRET
```

---

## Local Development

```bash
pnpm install
pnpm dev           # frontend only on :5173 (points to production API)
pnpm dev:all       # worker on :8787 + frontend on :5173 (full local stack)
```

Environment files:

| File | `VITE_API_URL` | When used |
|---|---|---|
| `.env.example` | `https://api.floppy.cloud` | Production / frontend-only dev |
| `app/.env.development.local` | `http://localhost:8787` | Full local stack with `wrangler dev` |
