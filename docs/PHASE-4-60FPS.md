# RemoteDesk — higher-frame-rate H.264 preview

This build configures OpenH264 for up to 60 FPS, screen-content real-time usage, low encoder complexity, automatic threading, frame skipping under load, H.264 level 4.0, and a 6 Mbps target bitrate. Frame pacing uses 16,667 microseconds and the browser receives a native WebRTC H.264 video track.

## Important

The 60 FPS value is a target, not a measured guarantee. `screenshots` desktop capture and software encoding may not sustain 60 FPS on all systems. The Host prints measured FPS and mean capture/encode/send times every 5 seconds. If encode time exceeds 16.7 ms, use a smaller resolution or hardware encoding; if capture exceeds that interval, the current screenshot capture path is the bottleneck.

The connection remains STUN-only and does not use TURN. Direct WebRTC can fail on some NAT/firewall combinations. Mouse and keyboard remain disabled.

## Run

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = "https://remotedesk-api.andrey-765-sereda.workers.dev"
cargo run
```
