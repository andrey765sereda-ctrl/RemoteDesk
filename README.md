# RemoteDesk — Phase 1

RemoteDesk is an experimental remote-desktop project for Windows 11 + iPhone. This phase creates the static web client, a Cloudflare Worker API scaffold, and a Rust Windows host health-check. It does **not** yet stream the screen or accept mouse/keyboard input.

## Architecture

- `web/`: static client for GitHub Pages.
- `worker/`: Cloudflare Worker API (health endpoint and explicitly non-sensitive session metadata scaffold).
- `windows-host/`: Rust host health-check bound to `127.0.0.1` only.
- `protocol/`: protocol notes.

## Prerequisites

- Windows 11
- Rust stable (`rustup`)
- Node.js 20+ and npm
- Cloudflare account and Wrangler (`npx wrangler`)
- GitHub account/repository

## 1. Run the Windows host locally

From PowerShell:

```powershell
cd windows-host
cargo run
```

Then, in another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:47831/health
```

The host binds only to loopback. This is intentional: do not expose this endpoint to the internet. A future phase will add authenticated transport and a proper WebRTC implementation.

## 2. Run the website locally

From the repository root:

```powershell
cd web
python -m http.server 8080
```

Open `http://localhost:8080` in a browser. Set the Worker API URL in the website settings once the Worker has been deployed.

## 3. Deploy the Cloudflare Worker

From the repository root:

```powershell
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Copy the deployed Worker URL (for example `https://remotedesk-api.<your-subdomain>.workers.dev`) into the website's API URL field. The Worker currently exposes `/api/health` only. It deliberately does not expose endpoints that could execute commands or grant remote control.

## 4. Publish GitHub Pages

1. Create a GitHub repository named `RemoteDesk` (or another name).
2. Push the repository contents to its default branch.
3. In GitHub, open **Settings → Pages**.
4. Set **Build and deployment → Source** to **GitHub Actions**.
5. The workflow `.github/workflows/pages.yml` publishes the `web/` folder.
6. If the repo is not named `<username>.github.io`, the workflow configures the correct Pages base path automatically.

## Security status

This is a development scaffold, not a secure remote-access product yet. Do not forward ports to the Rust host. Do not put API keys, pairing secrets, or private tokens in the static website. Before remote-control functionality is added, the project needs device pairing, short-lived credentials, authenticated signaling, a WebRTC transport, replay protection, and explicit session authorization.
