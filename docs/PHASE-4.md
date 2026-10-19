# RemoteDesk — Phase 4: H.264 WebRTC video

This phase replaces JPEG frames sent in a reliable WebRTC DataChannel with a real H.264 video media track carried as RTP over WebRTC.

## What changed

- Windows captures the primary display, scales it to fit within 1280×720 with even dimensions, converts pixels to RGB, and encodes them using the OpenH264 software encoder.
- The H.264 Annex-B access units are written to a `TrackLocalStaticSample` video track.
- The browser receives a native WebRTC video track and renders it in a `<video>` element. The iPhone page prefers H.264 codecs for this transceiver.
- The existing Cloudflare Worker API and signaling messages remain unchanged. No Worker redeploy is required for this version unless the current Worker is out of sync with the deployed signaling API.
- STUN-only remains enabled. No TURN relay is configured. Mouse and keyboard input remain disabled.

## Build and run on Windows 11

Stop the existing Host with `Ctrl+C`. Replace the project files using the archive, without copying build folders or removing `.git`.

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```

The first build compiles the bundled OpenH264 C/C++ source and can take longer than the previous JPEG-only build. A working Visual Studio C++ build toolchain may be needed. If Cargo reports an OpenH264 build error, save the complete first error block; do not install random codec binaries from third-party websites.

Keep the Host terminal open, enter the one-time code on the iPhone website, and approve the session in the terminal. The page should show `H.264` and the video dimensions once it receives the first decoded frame.

## Publish the website

The Worker endpoints have not changed. Publish the updated static site via GitHub Actions:

```powershell
cd D:\Projects\RemoteDesk
git status
git add .
git commit -m "Replace JPEG preview with H264 WebRTC video"
git push origin main
```

Wait until GitHub Actions finishes, then reload the RemoteDesk site on iPhone. If the old JavaScript is cached, close the Safari tab and reopen the site, or reload again.

No Worker redeploy is needed for H.264 itself because Cloudflare continues to exchange only the existing SDP offer and answer. The video flows peer-to-peer; Cloudflare does not relay the frames.

## Metrics and expected behavior

The Host logs every five seconds:

`H.264 performance: <fps> FPS | avg frame <KiB> | capture <ms> | encode <ms> | send <ms>`

This build uses a software encoder and targets about 15 FPS, capped at 1280×720. Actual FPS depends on screen capture cost, CPU, network, and WebRTC packet loss. H.264 reduces bandwidth significantly for typical desktop changes; it does not guarantee hardware encoding or 15 FPS on every PC.

## Limits

- Read-only: no mouse, keyboard, clipboard, or file transfer.
- STUN only: direct WebRTC may fail behind restrictive NATs/firewalls without TURN. This has not changed.
- This is a prototype; test the Rust build locally before treating the phase as complete. The authoring environment could not run Cargo/Windows builds.
