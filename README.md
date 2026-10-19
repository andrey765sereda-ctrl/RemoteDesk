# RemoteDesk

RemoteDesk is a personal Windows 11 remote-desktop project with owner-approved input from an iPhone browser. OBS + MediaMTX handle video. The Rust Host handles only approved mouse/keyboard input. Cloudflare Worker handles pairing and small control messages; it never carries video.

## Components

- `web/`: GitHub Pages client. Includes the MediaMTX WebRTC player in an inline iframe, a relative mouse touchpad, mouse buttons, keys, text input and command test status.
- `worker/`: Cloudflare Worker + Durable Object for temporary pairing and an authenticated WSS control relay.
- `windows-host/`: Rust Host; creates a one-time pairing code, asks for local terminal approval, connects outbound to Worker over WSS and injects allow-listed inputs through Enigo.
- `config/mediamtx-tailscale.example.yml`: settings to advertise your Windows Tailscale IP as a WebRTC ICE candidate.
- `docs/MOBILE-INTERNET.md`: instructions for mobile-data access, embedded video and control troubleshooting.

## Control channel

- Host input is disabled until a valid pairing request is explicitly approved in the Windows terminal.
- The Host opens an outbound secure WebSocket; no inbound Windows port is required for control.
- The Worker authenticates the Host with the session's host secret and the browser with its client token.
- Commands are allow-listed: relative pointer movement, mouse buttons, wheel, supported keys, text up to 500 characters, and release-all. There is no shell or arbitrary command execution endpoint.
- Host releases held buttons/keys when the control channel closes or the browser disconnects.
- The browser enables the control buttons only after the Host connection and Windows input API are both ready. Actual command results are returned to the browser, with errors printed in the Host console.
- Pairing sessions expire after 30 minutes after approval; restart Host to start a new session.

## Mobile internet and inline video

Follow `docs/MOBILE-INTERNET.md`. In brief: install Tailscale on Windows and iPhone; configure MediaMTX to advertise the Host's Tailscale IP for WebRTC; expose only the MediaMTX web/player endpoint to the tailnet with `tailscale serve --bg --https=443 http://127.0.0.1:8889`; the current preconfigured viewer URL is `https://flygribbpc.tail28d1f0.ts.net/remotedesk` (it is pre-filled and the inline player starts automatically). Keep Tailscale connected on the iPhone on cellular data. Do not public-port-forward MediaMTX.

## Deploy/update

Copy files from the archive into `D:\Projects\RemoteDesk`, keeping `.git` and not copying `target/` or `node_modules/`.

```powershell
cd D:\Projects\RemoteDesk
# After reviewing `git status`:
git add .gitignore README.md docs config protocol web windows-host/Cargo.toml windows-host/src/main.rs worker/package.json worker/src/index.ts
git commit -m "Embed MediaMTX and add control diagnostics"
git push origin main
```

Then deploy the Worker:

```powershell
cd D:\Projects\RemoteDesk\worker
npm.cmd install
npm.cmd run typecheck
npx.cmd wrangler deploy
```

Wait for GitHub Actions to publish Pages. Then start Host:

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```

Enter the current one-time pairing code on GitHub Pages and approve it in the Windows terminal.

## Notes and limitations

- The GitHub Pages video iframe requires an HTTPS MediaMTX player URL; plain `http://192.168.x.x` is blocked as mixed content on an HTTPS page. Use Tailscale Serve HTTPS.
- Tailscale must be installed and connected on both devices for mobile-data video access. Tailscale can use an encrypted relay when a direct tailnet path is unavailable.
- This is an early personal remote-access project, not a signed commercial remote-desktop product. Run Host as an ordinary user where possible and approve only pairing requests you initiated.
