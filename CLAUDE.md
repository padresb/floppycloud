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
pnpm --filter app dev           # Frontend only (localhost:5173)
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
│       ├── lib/                # Core logic (webrtc, crypto, signaling, transfer, phrase)
│       ├── ui/                 # UI components (sender, receiver, progress, toast)
│       └── pages/              # Page views (home, room)
├── worker/                     # Cloudflare Worker (signaling + rate limiting)
│   ├── wrangler.toml           # Cloudflare Worker config
│   └── src/
│       ├── index.ts            # Worker entry, routing, Env interface, CORS
│       ├── room.ts             # TransferRoom Durable Object (30-min TTL, alarm cleanup)
│       ├── ratelimit.ts        # IP-based rate limiting via KV (multi-level)
│       ├── turn.ts             # Cloudflare Calls TURN credential fetch + normalization
│       ├── types.ts            # Worker types
│       └── utils.ts            # Phrase generation (163 adj × 156 nouns), validation
```

## Conventions
- No React/Next.js/Express — vanilla TS only on frontend, Workers on backend
- All signaling goes through WebSocket via Durable Objects
- AES-256-GCM key lives only in URL fragment (#key=...) — never sent to server
- Phrase format: `adjective-noun` (e.g., `golden-harbor`) — no numbers, validated with `/^[a-z]+-[a-z]+$/` (6-40 chars)
- Files stream P2P via WebRTC data channels, never touch the server
- Session ends when sender disconnects — link permanently expires (DO storage cleared)
- Sender/receiver logs prefixed `[sender]`/`[receiver]` for all signaling and connection events

## Transfer Protocol
- **Chunk size**: 64 KB (65,536 bytes)
- **Max file size**: 2 GB (configurable via `MAX_FILE_SIZE_MB` / `VITE_MAX_FILE_SIZE_MB`)
- **Flow**: JSON metadata → encrypted binary chunks → `TRANSFER_COMPLETE` JSON
- **Ordered decryption**: Promise chaining enforces strict wire order during async decrypt to prevent corruption
- **Backpressure**: Monitors `bufferedAmount`, pauses when exceeding 8 chunks
- **Security labels**: "end-to-end encrypted" (with #key) vs "transport security" (DTLS-SRTP only)
- Per-session transfer log with elapsed time shown on both sender and receiver

## Rate Limits (IP-based, KV-backed)
- Global: 100 req/min
- Create room: 10 req/min
- WebSocket: 30 req/min
- TURN credentials: 20 req/min

## TURN / ICE
- Credentials fetched from Cloudflare Calls API with 24-hour TTL
- Server deduplication, STUN credential stripping, fallback STUN (`stun:stun.cloudflare.com:3478`)
- ICE restart triggered on `iceConnectionState === "failed"`

## CORS
- Production origins: `https://floppy.cloud`, `https://www.floppy.cloud`
- Non-production: `*`
- Includes `Vary: Origin` header

## Environment Variables
- Frontend (Vite): `VITE_API_URL` (default: `http://localhost:8787` for dev), `VITE_MAX_FILE_SIZE_MB` (default: 2048)
- Worker secrets: `CF_CALLS_APP_ID`, `CF_CALLS_APP_SECRET` (set via `wrangler secret put`)
- Worker vars (wrangler.toml): `MAX_FILE_SIZE_MB`, `SESSION_TTL_SECONDS`, `CHUNK_SIZE_BYTES`, `ENVIRONMENT`

## Deployment
```bash
wrangler deploy                                           # Deploy Worker
pnpm --filter app build && wrangler pages deploy app/dist --project-name floppycloud  # Deploy Pages
```
