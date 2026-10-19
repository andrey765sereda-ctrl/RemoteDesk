# Remote control (Phase 5+)

## Architecture

- OBS captures the Windows desktop and encodes H.264 with NVENC.
- MediaMTX publishes the stream through WebRTC.
- `web/` embeds MediaMTX's built-in WebRTC viewer directly inside the GitHub Pages page.
- `worker/` relays short, allow-listed control messages over an authenticated WebSocket. Video never travels through Worker.
- `windows-host/` injects mouse/keyboard commands into the currently logged-in Windows desktop after explicit approval in the terminal.

For access on cellular networks, use Tailscale on both Windows and iPhone, configure MediaMTX to advertise the Windows Tailscale IP as a WebRTC ICE candidate, and use Tailscale Serve's HTTPS URL in the embedded viewer. See `docs/MOBILE-INTERNET.md`.

## Control readiness and diagnostics

The browser does not enable controls until both the Host WebSocket is connected and the Host has reported that Enigo initialized successfully. Commands are acknowledged after Enigo attempts the actual Windows input operation, not merely when a command is placed in a queue. Errors are shown on the website and in the Windows terminal.

Use the page's “Проверить управление (сдвиг курсора)” test action. If the page says Windows input API is unavailable, read the Host console message. Input may not reach elevated windows, UAC secure desktop, lock screen, or a different Windows login session when the Host is running as an ordinary user.

## Deployment

1. Update GitHub Pages by committing the contents of `web/` and waiting for Actions.
2. Deploy the Worker after changing `worker/src/index.ts`:

   ```powershell
   cd D:\Projects\RemoteDesk\worker
   npm.cmd install
   npm.cmd run typecheck
   npx.cmd wrangler deploy
   ```

3. Rebuild/restart Host:

   ```powershell
   cd D:\Projects\RemoteDesk\windows-host
   $env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
   cargo run
   ```

4. Enter a new pairing code and approve it in the Windows terminal.
