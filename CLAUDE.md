# Floppy.cloud — Development Guide

## Project Overview
Peer-to-peer WebRTC file transfer app. No login, no server storage. Cloudflare-native infrastructure.

## Architecture
- **Monorepo** with pnpm workspaces: `app/` (frontend) and `worker/` (Cloudflare Worker)
- **Frontend**: Vite + vanilla TypeScript + Tailwind CSS v3, deployed to Cloudflare Pages
- **Backend**: Cloudflare Workers + Durable Objects (signaling), KV (rate limiting), Calls API (TURN)

## Key Commands
```bash
pnpm install                    # Install all dependencies
pnpm dev                        # Run both worker and frontend concurrently
pnpm dev:app                    # Frontend only (localhost:5173)
pnpm --filter worker dev        # Worker only (localhost:8787)
pnpm build                      # Build both packages
pnpm typecheck                  # TypeScript check across all packages
```

## Project Structure
```
floppycloud/
├── app/                        # Frontend (Cloudflare Pages)
│   └── src/
│       ├── main.ts             # Entry point, SPA router
│       ├── types.ts            # Shared TypeScript types
│       ├── lib/
│       │   ├── webrtc.ts       # RTCPeerConnection factory + ICE config fetch (GET /api/turn)
│       │   ├── crypto.ts       # AES-256-GCM key gen/export/import/encrypt/decrypt (Web Crypto API)
│       │   ├── signaling.ts    # SignalingClient: WebSocket wrapper, typed event handlers
│       │   ├── transfer.ts     # sendFile / receiveFile: chunked AES-GCM over RTCDataChannel
│       │   └── phrase.ts       # Client-side phrase helpers
│       ├── ui/
│       │   ├── sender.ts       # Sender UI: share link, file drop, progress, chat, callbacks
│       │   ├── receiver.ts     # Receiver UI: waiting state, progress, download, chat, callbacks
│       │   ├── chat.ts         # Chat panel: message bubbles, typing indicator, enable/disable
│       │   ├── progress.ts     # Animated progress bar with transfer speed readout
│       │   └── toast.ts        # Toast notifications (info/error)
│       └── pages/              # Page views (home, room)
├── worker/                     # Cloudflare Worker (signaling + rate limiting)
│   ├── wrangler.toml           # Cloudflare Worker config
│   └── src/
│       ├── index.ts            # Worker entry, routing, Env interface, CORS
│       ├── room.ts             # TransferRoom Durable Object (30-min pre-connect TTL, 10-min idle TTL, alarm cleanup)
│       ├── ratelimit.ts        # IP-based rate limiting via KV (multi-level)
│       ├── turn.ts             # Cloudflare Calls TURN credential fetch + normalization
│       ├── types.ts            # Worker types
│       └── utils.ts            # Phrase generation (163 adj × 156 nouns), validation
```

## Conventions
- No React/Next.js/Express — vanilla TS only on frontend, Workers on backend
- All signaling goes through WebSocket via Durable Objects
- AES-256-GCM key is either in URL fragment (#key=...) or relayed over the DTLS-SRTP data channel — never sent to the signaling server
- Phrase format: `adjective-noun` (e.g., `golden-harbor`) — no numbers, validated with `/^[a-z]+-[a-z]+$/` (6-40 chars)
- Files stream P2P via WebRTC data channels, never touch the server
- Session ends when sender disconnects — link permanently expires (DO storage cleared)
- Session TTL: 30 min waiting for first connection; resets to 10 min idle once receiver joins, and resets again after each `TRANSFER_COMPLETE` — all three reset points in `worker/src/room.ts`
- Sender/receiver logs prefixed `[sender]`/`[receiver]` for all signaling and connection events
- Sender vs. receiver role is determined in `pages/room.ts` by `sessionStorage.getItem("floppycloud_owned_phrase") === phrase`; anyone without that stored value is treated as a receiver

## Connection Flow

Full sequence from page load to first data channel open. Primary source: `app/src/pages/room.ts`.

### 1 — Sender setup
- Generates an AES-256-GCM key (`lib/crypto.ts:generateKey`)
- Builds shareable link: `/{phrase}#key=<base64>` and updates URL hash without navigation
- Opens WebSocket: `wss://api.floppy.cloud/api/rooms/{phrase}/ws?role=sender`
- DO tags this socket as `"sender"` and sets a 30-min expiry alarm
- Waits for a `PEER_JOINED` signal from the server

### 2 — Receiver setup
- Checks URL hash for `#key=<base64>`; if present, imports the key immediately (`lib/crypto.ts:importKeyFromBase64`)
- Opens WebSocket: `wss://api.floppy.cloud/api/rooms/{phrase}/ws?role=receiver`
- DO verifies a sender socket exists (closes with code `4001` if not), tags socket as `"receiver"`, resets alarm to 10-min idle, sends `PEER_JOINED` to the sender

### 3 — WebRTC handshake (triggered by PEER_JOINED on sender)
1. Sender fetches TURN credentials (`GET /api/turn` → `lib/webrtc.ts:getIceConfig`)
2. Sender creates `RTCPeerConnection` with `{ iceServers: [...], iceCandidatePoolSize: 10 }`
3. Sender creates two ordered `RTCDataChannel`s:
   - `"fileTransfer"` (`binaryType: "arraybuffer"`) — encrypted file stream
   - `"chat"` — JSON chat and typing messages
4. Sender calls `createOffer()`, sets local description, sends `OFFER` payload over WebSocket
5. Receiver receives `OFFER`, fetches TURN credentials, creates `RTCPeerConnection`, sets remote description, flushes any buffered ICE candidates from `pendingReceiverCandidates`, calls `createAnswer()`, sets local description, sends `ANSWER`
6. Both sides trickle `ICE_CANDIDATE` messages via the signaling WebSocket as candidates are gathered. Candidates arriving before `setRemoteDescription` are buffered in `pendingSenderCandidates` / `pendingReceiverCandidates` and flushed once the remote description is set

### 4 — Connection established
- ICE negotiation completes — path is either **direct P2P** (host/srflx candidates) or **TURN relay** (relay candidates)
- Sender detects path type: on `connectionState === "connected"`, calls `pc.getStats()`, finds the nominated `candidate-pair`, reads its `localCandidateId`, checks `candidateType === "relay"`. Logged as `[sender] connection type: TURN relay` or `direct P2P`; UI updates to reflect this
- **`fileTransfer` channel open**: sender immediately sends `{ type: "KEY_RELAY", key: <base64> }` as the first message; receiver either imports it or ignores it if it already has a URL key, then signals the UI ready
- **`chat` channel open**: both sides enable the chat panel

### 5 — ICE restart
- Triggered on **sender only** when `iceConnectionState === "failed"`
- Sender calls `pc.createOffer({ iceRestart: true })`, sets local description, re-sends a new `OFFER` over signaling
- Receiver detects a re-offer by checking `if (pc)` before creating a new `RTCPeerConnection` — reuses the existing PC, sets the new remote description, flushes buffered candidates, sends a new `ANSWER`
- ICE restart replaces ICE credentials and re-gathers candidates without tearing down existing data channels

### 6 — Session teardown
- **Sender closes tab**: WebSocket closes → DO sends `ERROR { code: "PEER_DISCONNECTED" }` to receiver, closes all sockets, clears DO storage
- **Sender clicks End Session**: sends `DISCONNECT` over WebSocket → DO forwards to receiver, closes all sockets, deletes storage
- **Idle TTL expires**: DO alarm fires → `ROOM_EXPIRED` sent to both peers, sockets closed, storage cleared

## Signaling Protocol

All WebSocket messages are JSON: `{ type: string, payload?: object }`. Errors use `{ type: "ERROR", error: { code, message } }`. The Durable Object (`worker/src/room.ts`) relays `OFFER`, `ANSWER`, and `ICE_CANDIDATE` verbatim to the other peer; all other types are handled by the DO itself.

| Direction | Message | Payload | Description |
|---|---|---|---|
| Server → Sender | `PEER_JOINED` | — | Receiver connected; sender begins WebRTC handshake |
| Sender → Receiver (relayed) | `OFFER` | `{ sdp, type }` | SDP offer |
| Receiver → Sender (relayed) | `ANSWER` | `{ sdp, type }` | SDP answer |
| Either → Other (relayed) | `ICE_CANDIDATE` | `{ candidate: RTCIceCandidateInit }` | Trickle ICE candidate |
| Sender → Receiver | `TRANSFER_COMPLETE` | — | File done; DO also resets idle TTL to 10 min |
| Either → Other | `DISCONNECT` | — | Explicit end; DO closes all sockets and clears storage |
| Server → Both | `ROOM_EXPIRED` | — | DO alarm fired; session is over |
| Server → Other peer | `ERROR` | `{ code: "PEER_DISCONNECTED", message }` | Sent when a WebSocket closes unexpectedly (via `webSocketClose`) |

## Key Delivery
Two receiver flows are supported — both use the same AES-256-GCM key generated by the sender:

- **Full URL** (`/{phrase}#key=...`): receiver imports key from URL fragment. Key never transits the network. Status: "End-to-end encrypted".
- **Phrase only** (`/{phrase}`): receiver connects via home page phrase input with no key. On data channel open, sender sends `{ type: "KEY_RELAY", key: <base64> }` as the first data channel message (over DTLS-SRTP). Receiver imports it. Status: "Encrypted".

The `KEY_RELAY` message is always sent by the sender on `dataChannel.onopen`, regardless of which path the receiver used. Receivers with a URL key ignore the relayed key content and use their own.

## Transfer Protocol
- **Chunk size**: 64 KB (65,536 bytes)
- **Max file size**: 2 GB (configurable via `MAX_FILE_SIZE_MB` / `VITE_MAX_FILE_SIZE_MB`)
- **Flow**: `KEY_RELAY` JSON → METADATA JSON → encrypted binary chunks → `TRANSFER_COMPLETE` JSON
- **Ordered decryption**: Promise chaining enforces strict wire order during async decrypt to prevent corruption
- **Backpressure**: Monitors `bufferedAmount`, pauses when exceeding 8 chunks
- Per-session transfer log with elapsed time shown on both sender and receiver

## Chat Protocol
- A **separate** `RTCDataChannel` labeled `"chat"` (ordered) is created by the sender alongside the file transfer channel
- Receiver picks it up via `pc.ondatachannel` by checking `dc.label === "chat"`
- Both sides enable the chat panel (`ui/chat.ts`) once their chat channel opens, and disable it on disconnect
- Two message types sent over the chat channel (JSON-encoded):
  - `{ type: "CHAT", text: string }` — a chat message
  - `{ type: "TYPING" }` — typing indicator (throttled to at most once per second per sender)
- Typing indicator auto-hides on the receiving side after 2 seconds of no new `TYPING` signals
- Chat messages are **never stored** — they exist only in-memory for the duration of the session
- Chat uses the same DTLS-SRTP encrypted WebRTC channel as the file transfer; no additional encryption layer is applied beyond what WebRTC provides

## Rate Limits (IP-based, KV-backed)
All limits are per IP, per 60-second window. Values are hardcoded inline in `worker/src/index.ts` as the third argument to `checkRateLimit()`:

| Action | Limit | index.ts line |
|---|---|---|
| Global (all requests) | 100/min | 41 |
| `POST /api/rooms` (create room) | 10/min | 49 |
| `GET /api/rooms/:code/ws` (WebSocket) | 30/min | 72 |
| `GET /api/turn` (TURN credentials) | 20/min | 86 |

KV windowing logic is in `worker/src/ratelimit.ts`. To change a limit, update the hardcoded value at the corresponding line in `index.ts`.

## ICE & TURN

### Credential fetch (`app/src/lib/webrtc.ts:getIceConfig`)
- Both sender and receiver independently call `GET /api/turn` when starting WebRTC
- Worker fetches ephemeral credentials from Cloudflare Calls API (`POST https://rtc.live.cloudflare.com/v1/turn/keys/{CF_CALLS_APP_ID}/credentials/generate`) with a 24-hour TTL
- `worker/src/turn.ts:normalizeIceServers` deduplicates URLs, strips credentials from `stun:` entries, and always prepends `stun:stun.cloudflare.com:3478` if not already present
- If `GET /api/turn` fails for any reason (network error, missing secrets, rate limit), `getIceConfig` silently falls back to STUN-only: `{ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }`
- STUN-only fallback means peers behind symmetric NAT will fail to connect — configure TURN secrets for reliable cellular/corporate network support

### RTCPeerConnection config
```ts
{ iceServers: [...normalizedServers], iceCandidatePoolSize: 10 }
```
`iceCandidatePoolSize: 10` causes the browser to pre-gather candidates before `setLocalDescription`, reducing time-to-connect.

### ICE restart
- Sender-only: triggered when `iceConnectionState === "failed"` (`pages/room.ts:131`)
- Calls `pc.createOffer({ iceRestart: true })` → new local description → new `OFFER` over signaling
- Receiver reuses the existing `RTCPeerConnection` on re-offer (detected by `if (pc)` guard at `pages/room.ts:336`), avoiding data channel teardown

### Troubleshooting connection failures

| Symptom | Likely cause | Where to look |
|---|---|---|
| `connectionState: "failed"`, ICE restart doesn't recover | Symmetric NAT on both sides, TURN not configured | Check `CF_CALLS_APP_ID`/`CF_CALLS_APP_SECRET`; verify `/api/turn` returns `turn:` relay entries |
| Toast: "Could not establish secure channel" | `connectionState: "failed"` (shown once per session) | Console: `[sender] ICE state:` and `[sender] connection state:` |
| Receiver sees `ROOM_EXPIRED` or `4001` close code | No sender socket when receiver joined, or session timed out | Check sender WebSocket connected first; check DO alarm timing |
| `OFFER` never reaches receiver | Receiver connected before sender's `PEER_JOINED` triggered WebRTC setup | Console: `[receiver] signal received:` — should see `OFFER` after joining |
| Data channel never opens | ICE connected but DTLS handshake failed | Console: absence of `[sender] data channel OPEN` after `connectionState: connected` |
| `KEY_RELAY` received but file never starts | `binaryType` mismatch or message ordering issue | Verify `dataChannel.binaryType = "arraybuffer"` set before `onmessage` |
| Transfer starts but data is corrupted | IV reuse or out-of-order decryption | A single IV is used for all chunks; `Promise` chain in `receiveFile` enforces order |

Use `chrome://webrtc-internals` for deep ICE diagnostics (candidate pairs, DTLS state, SCTP). All events are logged with `[sender]`/`[receiver]` prefixes in the browser console.

## CORS
- Production origins: `https://floppy.cloud`, `https://www.floppy.cloud`
- Non-production: `*`
- Includes `Vary: Origin` header

## Environment Variables
- Frontend (Vite): `VITE_API_URL` (`https://api.floppy.cloud` in production / frontend-only dev; `http://localhost:8787` only when running full local stack via `wrangler dev`), `VITE_MAX_FILE_SIZE_MB` (default: 2048)
- Worker secrets: `CF_CALLS_APP_ID`, `CF_CALLS_APP_SECRET` (set via `wrangler secret put`)
- Worker vars (wrangler.toml): `MAX_FILE_SIZE_MB`, `SESSION_TTL_SECONDS`, `CHUNK_SIZE_BYTES`, `ENVIRONMENT`

## Deployment
```bash
wrangler deploy                                           # Deploy Worker
pnpm --filter app build && wrangler pages deploy app/dist --project-name floppycloud  # Deploy Pages
```
