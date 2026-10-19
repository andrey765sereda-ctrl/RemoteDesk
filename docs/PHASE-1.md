# Phase 1: scaffold and connectivity checks

## Windows Host

Install Rust stable, then run in PowerShell:

```powershell
cd windows-host
cargo run
```

Test in a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:47831/health
```

The host is intentionally loopback-only. The website currently checks the Cloudflare Worker health endpoint, not the Windows Host directly.

## Cloudflare Worker

```powershell
cd worker
npm install
npx wrangler login
npx wrangler dev
```

Test locally at `http://127.0.0.1:8787/api/health`. Then deploy with `npx wrangler deploy`.

## GitHub Pages

Push the repository to GitHub and select **Settings → Pages → GitHub Actions**. The workflow publishes `web/`.

## Scope

No screen capture, mouse/keyboard injection, pairing, or remote-control endpoints are implemented in this phase. That is intentional until authentication and the transport design are in place.
