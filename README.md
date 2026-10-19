# RemoteDesk

RemoteDesk provides a private, owner-approved control channel from an iPhone browser to a Windows 11 host. The video stream is handled separately by OBS Studio + MediaMTX; the Rust Host in this build handles input commands only.

## Components

- `web/`: GitHub Pages control interface; touchpad, mouse buttons, special keys, and text entry.
- `worker/`: Cloudflare Worker + Durable Object for one-time pairing approval and an authenticated WebSocket relay. The relay carries control messages only, not video.
- `windows-host/`: Rust Host. It creates a five-minute pairing code, requires local terminal approval, connects outbound to the Worker over WSS, and injects allowed mouse/keyboard input through Enigo.
- OBS Studio + MediaMTX: independent video path. The control site can open your existing MediaMTX viewer in another Safari tab.

## Security properties

- Host input is disabled until a valid pairing request is explicitly approved in the Windows terminal.
- The Host opens an outbound secure WebSocket; no inbound Windows port is required for control.
- Worker authenticates Host with the session's host secret and browser with its short-lived client token.
- Commands are allow-listed: relative pointer movement, mouse buttons, wheel, a limited set of keys, text up to 500 characters, and release-all. There is no shell or arbitrary command execution endpoint.
- Host releases held buttons/keys when the control channel closes or the browser disconnects.
- Pairing sessions expire after 30 minutes after approval; restart Host to begin a new session.
- Run Host as a normal user, not as Administrator, unless you have a specific need. Remote input may interact with the unlocked desktop, so only approve pairing requests you initiated.

## Update the project

1. Copy the files from this archive into your existing `D:\Projects\RemoteDesk` folder, replacing the matching files. Keep the existing `.git` folder.
2. Commit and push the changed source files (do not add `target/` or `node_modules/`):

   ```powershell
   cd D:\Projects\RemoteDesk
   git add .gitignore README.md docs protocol web windows-host/Cargo.toml windows-host/src/main.rs worker/package.json worker/src/index.ts
   git commit -m "Add authenticated remote input controls"
   git push origin main
   ```

3. Deploy the Worker:

   ```powershell
   cd D:\Projects\RemoteDesk\worker
   npm.cmd install
   npm.cmd run typecheck
   npx.cmd wrangler deploy
   ```

4. Wait for GitHub Actions to publish the Pages site.
5. Start Host:

   ```powershell
   cd D:\Projects\RemoteDesk\windows-host
   $env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
   cargo run
   ```

6. Enter the Host pairing code on the published website and confirm the request by typing `y` in the Windows terminal. The web UI should report that control is connected. Paste the MediaMTX viewer URL into the video section to open the stream in another browser tab.

## Notes

- The video path assumes you already configured OBS to publish H.264 through MediaMTX. It is independent of this Rust Host and Worker.
- The control channel relays small WebSocket messages through Cloudflare; video is never sent through Cloudflare Worker.
- This is a functional early control implementation, not a signed commercial remote-desktop product. Validate it on your own devices and keep the Host pairing approval prompt enabled.
