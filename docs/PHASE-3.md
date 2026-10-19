# RemoteDesk — Phase 3: WebRTC screen preview

This phase adds a **read-only screen preview** after explicit Windows-terminal approval. The Windows Host captures the first display, scales it to fit within 800×600, encodes JPEG at low quality, splits each frame into small data-channel chunks, and sends them over a WebRTC DataChannel. The iPhone Safari page reassembles the chunks and displays the latest frame.

This is deliberately a low-frame-rate proof of concept, not a finished remote-desktop video pipeline. It does not use H.264 or Windows Graphics Capture yet, and it does not send mouse/keyboard commands. Screen capture can consume CPU and WebRTC direct connectivity may fail behind some NATs because a TURN relay is not configured yet.

## Deploy updated website and Worker

From the project root:

```powershell
git status
git add .
git commit -m "Add read-only WebRTC screen preview"
git push origin main
```

Wait for the GitHub Actions Pages workflow to finish. Then redeploy the Worker:

```powershell
cd D:\Projects\RemoteDesk\worker
npm.cmd install
npm.cmd run typecheck
npx.cmd wrangler deploy
```

Keep the existing Worker URL. `PAGES_ORIGIN` in `wrangler.toml` should be the exact origin of the GitHub Pages site, without `/RemoteDesk/` or a trailing slash, e.g. `https://andrey765sereda-ctrl.github.io`. If it changes, redeploy after correcting it.

## Run the Windows Host

Stop any old Host process with `Ctrl+C`, then run:

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```

The first build downloads WebRTC and screen-capture dependencies and may take several minutes. Keep this terminal open. The Host shows a one-time code. Open the published page on the iPhone, enter the code, and approve the request in the Windows terminal. The browser should show a screen preview after the WebRTC channel opens.

## Current API additions

- `POST /api/rtc/host-offer`: Host publishes an SDP offer, authenticated by the Host secret.
- `POST /api/rtc/client-offer`: browser polls for the offer using its ephemeral client token.
- `POST /api/rtc/client-answer`: browser submits the SDP answer using its client token.
- `POST /api/rtc/host-answer`: Host polls for the answer using its Host secret.

SDP is exchanged only after the Durable Object session is approved. Descriptions are size-limited and retained only in the session record; the code clears them when an expired session is observed by a status/signaling request. Session lifetime after approval is 30 minutes. The Worker is only a signaling intermediary; it does not relay the screen frames.

## Limitations / security

- Mouse, keyboard, clipboard and file transfer are not implemented.
- This version intentionally uses STUN only (`stun:stun.cloudflare.com:3478`). It does not request or accept TURN credentials. Direct WebRTC connections can fail on some NAT/firewall/mobile networks. If Wi-Fi also fails, inspect Host ICE candidate counts and the browser screen-status message before changing the transport.
- No persistent trusted-device profile: each session requires a new one-time code and local approval.
- Do not enable router port forwarding for this Host. Its local health endpoint remains bound to `127.0.0.1:47831`.
- This code has not been compiled on the developer's Windows device in this environment. Run `cargo run` locally and report any compiler error before treating the phase as finished.


## Diagnostics

The Host prints local candidate counts (`host`, `srflx`, `relay`) and the iPhone answer candidate counts. In this STUN-only build, `relay=0` is expected. The iPhone page reports the ICE state in the screen status and logs candidate errors to the browser console. A `failed` ICE state means the signaling exchange completed but no usable network candidate pair connected. If the data channel opens but no frame arrives, investigate screen capture rather than network setup.


## If local Wi-Fi still cannot connect

1. Make sure the Windows network profile is **Private** for your home network.
2. If direct STUN cannot connect on your home Wi-Fi, run PowerShell as Administrator in `windows-host/` after `cargo run` has built the app:

```powershell
$exe = (Resolve-Path ".\target\debug\remotedesk-host.exe").Path
New-NetFirewallRule -DisplayName "RemoteDesk WebRTC (Private)" -Direction Inbound -Program $exe -Protocol UDP -Action Allow -Profile Private
```

This rule is only for the compiled Host executable on the Private profile. It does not open the local health server to the Internet. Remove the rule later with `Remove-NetFirewallRule -DisplayName "RemoteDesk WebRTC (Private)"` if you no longer use it.


## Performance tuning update

The sender targets a 100 ms start-to-start interval (up to 10 FPS) instead of waiting 700 ms after every frame. Actual FPS remains limited by synchronous desktop capture, JPEG encoding, network bandwidth, and reliable ordered DataChannel delivery. The Host prints five-second rolling stats: observed FPS, average JPEG frame size, capture time, and send time. If capture time is consistently high, the next improvement should be a native Windows Graphics Capture pipeline and video encoding rather than simply raising the target FPS.


> Superseded by [PHASE-4.md](PHASE-4.md): the current build sends a native H.264 RTP video track instead of JPEG chunks over a DataChannel.
