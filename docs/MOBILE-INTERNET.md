# RemoteDesk: mobile data, inline video, and control diagnostics

This setup intentionally keeps video out of Cloudflare Workers. OBS publishes H.264 to MediaMTX; the GitHub Pages site embeds MediaMTX's own WebRTC viewer in an iframe; Rust Host receives only authenticated mouse/keyboard commands over an outbound WSS connection through the Worker.

## Why Tailscale is needed for mobile-data viewing

The Cloudflare Worker makes the *control channel* reachable from cellular networks, but it does not relay video. MediaMTX WebRTC also needs a reachable ICE candidate for the UDP media stream. A private Tailscale network avoids router port-forwarding: install Tailscale on both Windows and the iPhone and sign in to the same tailnet. Keep Tailscale connected on the iPhone while using cellular data.

## 1. Configure MediaMTX to advertise the tailnet address

1. Install/start Tailscale on Windows and iPhone and sign in to the same account/tailnet.
2. Open PowerShell on Windows and run:

   ```powershell
   tailscale ip -4
   ```

   Copy the returned `100.x.y.z` address.
3. Open the `mediamtx.yml` file used by your `mediamtx.exe`. Add the settings in `config/mediamtx-tailscale.example.yml`; replace the example IP with the real Tailscale address. If an existing key is present, edit it rather than duplicating it.
4. Restart MediaMTX and restart the OBS stream.
5. Run PowerShell as Administrator and add a narrow firewall rule for WebRTC media from Tailscale peers:

   ```powershell
   $ts = Get-NetAdapter | Where-Object { $_.Name -match 'Tailscale' -and $_.Status -eq 'Up' } | Select-Object -First 1
   if (-not $ts) { throw 'Tailscale adapter not found. Check that Tailscale is connected.' }
   if (-not (Get-NetFirewallRule -DisplayName 'RemoteDesk MediaMTX WebRTC via Tailscale' -ErrorAction SilentlyContinue)) {
     New-NetFirewallRule -DisplayName 'RemoteDesk MediaMTX WebRTC via Tailscale' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8189 -RemoteAddress 100.64.0.0/10 -InterfaceAlias $ts.Name -Profile Any
   }
   ```

This rule is restricted to the Tailscale interface/address range. Do not port-forward 8889 or 8189 on your router and do not use Tailscale Funnel for a private desktop stream.

## 2. Give GitHub Pages an HTTPS MediaMTX URL

The GitHub Pages site is HTTPS, so a browser can block an embedded `http://192.168...` viewer as mixed content. Tailscale Serve provides a private HTTPS URL for the MediaMTX web endpoint.

In Tailscale Admin Console, enable HTTPS certificates for your tailnet if they are not enabled yet. Then, in PowerShell, run:

```powershell
 tailscale serve --bg --https=443 http://127.0.0.1:8889
 tailscale serve status
```

Copy the `https://<machine>.<tailnet>.ts.net` URL shown by `tailscale serve status`. The URL you enter on the RemoteDesk page should be:

`https://flygribbpc.tail28d1f0.ts.net/remotedesk` (уже предзаполнен в текущем веб-клиенте)

The iPhone must have Tailscale installed and connected to the same tailnet for this private HTTPS URL and the advertised UDP candidate to work. This works while the iPhone is on cellular data; no direct public exposure of MediaMTX is needed. Tailscale may use its encrypted relay when a direct path is unavailable.

## 3. Show video on the RemoteDesk site

Open the GitHub Pages RemoteDesk site. The HTTPS URL `https://flygribbpc.tail28d1f0.ts.net/remotedesk` is pre-filled, and the player starts inside the page automatically. No second tab is opened. To stop it, press “Остановить видео”. If Tailscale is disconnected on the iPhone, connect it and press “Остановить видео” then “Показать видео здесь”.

If the iframe page loads but the video stays black, check:

- OBS is streaming to `http://127.0.0.1:8889/remotedesk/whip`.
- The MediaMTX path is exactly `remotedesk`.
- `webrtcAdditionalHosts` contains the Windows Tailscale IPv4.
- The Windows firewall rule allows UDP 8189 from the Tailscale interface.
- Tailscale is Connected on both Windows and iPhone (including cellular use).

## 4. Control troubleshooting

1. On Windows, keep the Host console open and approve the pairing only after entering the code on your site.
2. The console should print `Remote-control channel authenticated` and `Windows input API ready=true`.
3. The page must show `Управление подключено` and `Windows input API готов` before enabling the controls.
4. Press “Проверить управление (сдвиг курсора)”. The site should receive an acknowledgement only after Enigo applied the movement. If it fails, the exact input API error is shown on the page and in the Host console.
5. Standard apps on the logged-in desktop can be controlled. Elevated apps, secure desktop/UAC prompts, lock screen, and another Windows user session may not accept input when Host is running as a normal user. Don't run it as Administrator unless you understand the implications.

The Worker carries only small allow-listed input commands and pairing messages, not video. Session pairing is owner-approved and time-limited.
