# Floppy.cloud

Send files directly to another person — no account, no storage, no middleman.

## What it does

Floppy.cloud is a browser-based file transfer tool that sends files peer-to-peer over an encrypted connection. Files go directly from your browser to the recipient's browser without being stored anywhere.

**How it works:**

1. Go to [floppy.cloud](https://floppy.cloud) and get a two-word session code (e.g. `golden-harbor`)
2. Share it with the person you're sending to — either the full link or just the two-word phrase
3. Once they connect, a secure channel is established between your browsers
4. Drop a file — it transfers directly to them

When you close the tab, the session ends and the link expires permanently.

**Two ways to share:**

- **Full link** (e.g. `https://floppy.cloud/golden-harbor#key=...`) — the encryption key is embedded in the URL and never transits the network. Strongest security.
- **Phrase only** (e.g. `golden-harbor`) — receiver types it on the home page. The key is delivered over the encrypted WebRTC channel once connected. Same encryption, different key delivery.

## Privacy

- Files are **encrypted with AES-256-GCM** — the server never sees your file contents
- **Full link**: key lives only in the URL fragment and is never sent over the network
- **Phrase only**: key is delivered over a DTLS-SRTP encrypted WebRTC channel — the signaling server never sees it
- No accounts, no logs, no storage

## Limits

- Up to 2 GB per transfer
- One file at a time
- Both sender and receiver must be online simultaneously
- Rate limited per IP: 10 new sessions/min, 30 connections/min, 100 total requests/min

## Tech

Built on Cloudflare's global network. WebRTC for peer-to-peer data channels, Cloudflare Workers for signaling, and Cloudflare Calls for TURN relay when a direct connection isn't possible.

## Development

See [CLAUDE.md](./CLAUDE.md) for architecture details and development setup.
