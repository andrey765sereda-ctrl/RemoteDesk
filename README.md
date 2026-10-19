# RemoteDesk — Phase 2: temporary device pairing

RemoteDesk is an experimental remote-desktop project for Windows 11 + iPhone, developed without requiring a Mac. The web interface is static and can be hosted on GitHub Pages. The API runs on Cloudflare Workers and uses a Durable Object to coordinate short-lived pairing requests. The Windows Host can ask the API to create a one-time code; the iPhone browser submits the code; the Host terminal must explicitly approve or reject the request.

**This phase does not stream the screen and does not send mouse/keyboard input.** A successful pairing means only that the user approved a temporary pairing request. Do not expose the loopback health endpoint or add router port forwarding.

## Project structure

- `web/`: mobile-first client for GitHub Pages.
- `worker/`: Cloudflare Worker API and `PairingDirectory` Durable Object.
- `windows-host/`: Rust Host with a loopback-only health endpoint and optional temporary pairing client.
- `protocol/`: message definitions and current limitations.
- `.github/workflows/pages.yml`: deploys the `web/` folder to GitHub Pages.

## Prerequisites

- Windows 11
- Rust stable (edition 2024 toolchain)
- Node.js LTS and npm (use `npm.cmd` / `npx.cmd` in PowerShell if script execution blocks `npm.ps1`)
- Git and a GitHub account
- Cloudflare account

## 1. Update the local project

Copy the contents of this archive over your existing `D:\Projects\RemoteDesk` project, replacing files when prompted. Keep the repository's `.git` directory. Then open PowerShell at the repository root:

```powershell
git status
git add .
git commit -m "Add temporary device pairing"
git push
```

Pushing will trigger the GitHub Pages workflow if it is enabled.

## 2. Configure the Worker

The Worker now needs a Durable Object binding. `worker/wrangler.toml` defines `PairingDirectory` and migration `v1`; Wrangler will create the Durable Object namespace during deployment.

```powershell
cd D:\Projects\RemoteDesk\worker
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler deploy
```

The command prints the deployed Worker URL. Keep using your current URL if Wrangler deploys to the same Worker:

`https://remotedesk-api.andrey-765-sereda.workers.dev`

After the GitHub Pages site is published, edit `worker/wrangler.toml` and set `PAGES_ORIGIN` to the exact origin, for example `https://YOUR_GITHUB_USERNAME.github.io` (no repository path, no trailing slash). Then redeploy. If you are using a different GitHub Pages domain, use that exact origin. Until set, the code allows HTTPS origins on `*.github.io` as a transitional setting.

## 3. Run the updated Windows Host and create a pairing code

Stop any old Host with `Ctrl+C`. In a new PowerShell window, run:

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```

The Host should print a temporary 12-character code grouped as `XXXX-XXXX-XXXX`. It expires after 5 minutes. Keep the Host terminal open. If the environment variable is absent, only the local health endpoint starts and pairing is disabled.

## 4. Test pairing from the iPhone

1. Push the updated `web/` folder to GitHub and wait for the Pages workflow to finish.
2. Open the published site in Safari on the iPhone. The API URL field is prefilled with the Worker URL; tap **Apply URL** if you changed it.
3. Enter the temporary code shown in the Windows terminal and tap **Request pairing**.
4. Return to the Windows terminal. Inspect the request and type `y` to approve or `n` (or Enter) to reject it.
5. The web page should show whether the request was approved or rejected.

Pairing is one-time and temporary. The browser keeps its client token only in page memory; refreshing the page loses the pending approval. Start a fresh Host process to get a new code.

## API endpoints

- `GET /api/health` — API health and capability summary.
- `POST /api/pairing/start` — Host registers a one-time code; Host-secret protected through the subsequent operations.
- `POST /api/pairing/claim` — browser claims the code and receives an ephemeral client token.
- `POST /api/pairing/host-status` — Host polls status using its secret.
- `POST /api/pairing/decision` — Host approves or rejects a pending request.
- `POST /api/pairing/client-status` — browser polls status using the ephemeral token.

## Security boundaries

- Only HTTPS Worker URLs are accepted by the Host pairing client.
- Pairing codes expire after 5 minutes and are single-use; claim attempts are rate-limited per client IP in the Durable Object.
- The Host generates a random secret that is never sent to the browser. The Worker stores only its SHA-256 hash.
- The browser receives a random one-time client token; the Worker stores only its SHA-256 hash. The token is held in page memory, not localStorage.
- Pairing requires explicit approval at the Windows terminal.
- The local `/health` endpoint remains bound to `127.0.0.1:47831` and cannot execute commands.
- CORS is a browser boundary, not authentication. Pairing secrets and explicit Host approval are the meaningful checks.

Before adding actual desktop access, the next phase must implement authenticated signaling and WebRTC, enforce session authorization on both ends, and validate all remote-control messages. Never expose the Host service with router port forwarding.
