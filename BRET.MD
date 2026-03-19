---
status: active
git: 'Yes'
hasRemote: true
remoteUrl: 'https://github.com/padresb/floppycloud'
ports:
  - 5173
  - 8787
techStack:
  - Node.js
  - TypeScript
  - Vite
  - Tailwind CSS
  - Cloudflare Workers
summary: >-
  Browser-based peer-to-peer file transfer tool using WebRTC with end-to-end
  encryption.
stars: 3
---

# FloppyCloud Documentation

## Testing
- Typechecking is run via `pnpm -r typecheck`.

## Virtual Environment
- This project uses a `pnpm` monorepo workspace. There is no Python virtual environment, but dependencies are managed via `pnpm install` in the root.

## Deployment & Production
- **Frontend** is deployed to Cloudflare Pages (`floppy.cloud`).
- **Backend (API + WebRTC signaling)** is deployed to Cloudflare Workers (`api.floppy.cloud`).
- **Deployment command:** Use `pnpm run deploy` (which runs `pnpm --filter worker deploy && pnpm --filter app deploy`).

## Run Locally
- **Frontend Only:** `pnpm dev:app` will start the vite server on port `5173` connecting to production API.
- **Full Stack (Frontend + Worker):** `pnpm dev` will run both the frontend (`5173`) and the local wrangler worker (`8787`) concurrently.

## Git Integration
- Deployed to Github: **Yes** (`origin https://github.com/padresb/floppycloud`).
