# RemoteDesk — Phase 3: WebRTC screen preview

RemoteDesk is an experimental Windows 11 + iPhone remote-desktop project built without requiring a Mac. The static iPhone web client is published with GitHub Pages. Cloudflare Workers + a Durable Object coordinate one-time pairing and WebRTC signaling. A Rust Host on Windows captures the desktop and sends low-rate JPEG frames over a WebRTC DataChannel after the user approves the pairing request in the Windows terminal.

**This phase is a read-only screen preview, not a finished remote-desktop product.** It sends small JPEG snapshots (about 1–2 frames per second depending on the PC and network), not H.264 video. Mouse, keyboard, clipboard and file transfer are disabled. This build intentionally uses STUN only and has no TURN relay or TURN credentials. Direct WebRTC may fail on networks whose NAT/firewall prevents peer-to-peer traffic. Do not expose the Host health endpoint or add router port forwarding.

## Project structure

- `web/`: mobile-first GitHub Pages client, pairing UI, WebRTC signaling client and frame reassembly.
- `worker/`: Cloudflare Worker API and `PairingDirectory` Durable Object for pairing, approval and short-lived SDP signaling.
- `windows-host/`: Rust Host; loopback-only health endpoint, temporary pairing client, screen capture and WebRTC DataChannel.
- `protocol/`: API and frame-message formats.
- `docs/PHASE-3.md`: deployment and testing instructions for this phase.
- `.github/workflows/pages.yml`: publishes `web/` using GitHub Pages.

## Prerequisites

- Windows 11
- Rust stable with Edition 2024 support
- Node.js and npm (`npm.cmd` / `npx.cmd` are convenient in PowerShell if `npm.ps1` is blocked)
- Git and GitHub account
- Cloudflare account with Workers and Durable Objects support
- iPhone with Safari

## Deploy web client and Worker

From the root of the repo:

```powershell
git status
git add .
git commit -m "Add read-only WebRTC screen preview"
git push origin main
```

Wait for the GitHub Actions workflow **Publish RemoteDesk web client** to complete. Then redeploy the Worker:

```powershell
cd D:\Projects\RemoteDesk\worker
npm.cmd install
npm.cmd run typecheck
npx.cmd wrangler deploy
```

The default Worker URL for this project is:

`https://remotedesk-api.andrey-765-sereda.workers.dev`

`worker/wrangler.toml` sets `PAGES_ORIGIN` to `https://andrey765sereda-ctrl.github.io`, with no repository path or trailing slash. If the site is published at another origin, update this variable and redeploy.

## Run the Windows Host

Stop any previous Host process with `Ctrl+C`. Then run:

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```

The initial build will download WebRTC and screen-capture dependencies and may take several minutes. The Host prints a one-time pairing code. Open the Pages site on the iPhone, enter that code, and approve the request in the Windows terminal. The client then exchanges an SDP offer/answer through Cloudflare and attempts to establish WebRTC directly with the Host. The browser should display updated JPEG frames once the data channel opens.

## Current API endpoints

- `GET /api/health` — Worker health and capability summary.
- `POST /api/pairing/start` — Host registers a one-time pairing code.
- `POST /api/pairing/claim` — browser claims the code and receives an ephemeral token.
- `POST /api/pairing/host-status` — Host polls the pairing state.
- `POST /api/pairing/decision` — Host approves or rejects the browser.
- `POST /api/pairing/client-status` — browser polls the pairing state.
- `POST /api/rtc/host-offer` — Host-secret-authenticated SDP offer publication.
- `POST /api/rtc/client-offer` — browser polls for the offer using its ephemeral token.
- `POST /api/rtc/client-answer` — browser submits its SDP answer.
- `POST /api/rtc/host-answer` — Host polls for the answer.

See `docs/PHASE-3.md` for protocol notes and known limitations.

## Security boundaries

- Pairing codes are one-use and expire after 5 minutes. Upon approval, the signaling session is extended for up to 30 minutes.
- The Host secret is never sent to the browser; the Worker stores only its SHA-256 hash. The browser token is randomly generated and stored in page memory, not localStorage; the Worker stores only its hash.
- The Host must explicitly approve the initial pairing request.
- The Worker passes SDP signaling only and does not relay screen frames. SDP is accepted only on an approved session and size-limited.
- The Host's local `/health` endpoint is bound to `127.0.0.1:47831` and cannot run commands.
- This phase sends no remote input. CORS is a browser boundary, not authentication; session secrets and approval are the actual checks.
- Do not configure router port forwarding. This STUN-only build cannot guarantee connections across every mobile/Wi-Fi network; if direct ICE fails, the session will not connect.

The current code has not been compiled on the target Windows computer from this environment. Run `cargo run` and `npm.cmd run typecheck` locally and report any errors before proceeding to mouse/keyboard input or performance work.
