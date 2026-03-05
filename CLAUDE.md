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
│   └── src/
│       ├── index.ts            # Worker entry, routing, Env interface
│       ├── room.ts             # TransferRoom Durable Object
│       ├── ratelimit.ts        # IP-based rate limiting via KV
│       ├── turn.ts             # Cloudflare Calls TURN credential fetch
│       ├── types.ts            # Worker types
│       └── utils.ts            # Phrase generation, validation
└── wrangler.toml               # Cloudflare Worker config
```

## Conventions
- No React/Next.js/Express — vanilla TS only on frontend, Workers on backend
- All signaling goes through WebSocket via Durable Objects
- AES-256-GCM key lives only in URL fragment (#key=...) — never sent to server
- Phrase format: `adjective-noun` (e.g., `golden-harbor`) — no numbers
- Files stream P2P via WebRTC data channels, never touch the server
- Session ends when sender disconnects — link permanently expires

## Environment Variables
- Frontend (Vite): `VITE_API_URL` (default: `http://localhost:8787` for dev)
- Worker secrets: `CF_CALLS_APP_ID`, `CF_CALLS_APP_SECRET` (set via `wrangler secret put`)

## Deployment
```bash
wrangler deploy                                           # Deploy Worker
pnpm --filter app build && wrangler pages deploy app/dist --project-name floppycloud  # Deploy Pages
```
