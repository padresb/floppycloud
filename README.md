# Floppy.cloud

Send files directly to another person — no account, no storage, no middleman.

## What it does

Floppy.cloud is a browser-based file transfer tool that sends files peer-to-peer over an encrypted connection. Files go directly from your browser to the recipient's browser without being stored anywhere.

**How it works:**

1. Go to [floppy.cloud](https://floppy.cloud) and get a two-word share link (e.g. `golden-harbor`)
2. Share the link with the person you're sending to
3. Once they open it, a secure channel is established between your browsers
4. Drop a file — it transfers directly to them

When you close the tab, the session ends and the link expires permanently.

## Privacy

- Files are **end-to-end encrypted** using AES-256-GCM
- The encryption key exists only in the URL fragment (`#key=...`) and never leaves your device
- The server only brokers the initial connection — it never sees your files or the key
- No accounts, no logs, no storage

## Limits

- Up to 2 GB per transfer
- One file at a time
- Both sender and receiver must be online simultaneously

## Tech

Built on Cloudflare's global network. WebRTC for peer-to-peer data channels, Cloudflare Workers for signaling, and Cloudflare Calls for TURN relay when a direct connection isn't possible.

## Development

See [CLAUDE.md](./CLAUDE.md) for architecture details and development setup.
