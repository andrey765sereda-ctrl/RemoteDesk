# RemoteDesk protocol — Phase 2

## Temporary pairing lifecycle

1. Windows Host generates a random 128-bit session ID, a random 256-bit host secret, and a one-time 48-bit hexadecimal pairing code.
2. Host submits the pairing data to `POST /api/pairing/start` over HTTPS.
3. iPhone browser submits the one-time code to `POST /api/pairing/claim`.
4. The Worker stores only SHA-256 hashes for the code, Host secret, and ephemeral client token.
5. The Host polls `POST /api/pairing/host-status` and requires explicit approval through `POST /api/pairing/decision`.
6. Browser polls `POST /api/pairing/client-status` using its ephemeral client token.
7. Code expires after five minutes and is consumed on the first successful claim.

## Pairing statuses

- `waiting`: Host registered a code; no browser has claimed it.
- `pending`: browser claimed the code; Host must decide.
- `approved`: Host approved the request.
- `rejected`: Host rejected the request.
- `expired`: the five-minute session expired.

## Security notes

- This mechanism is a pairing approval prototype, not a remote-control authorization system.
- No screen frames, keyboard input, or mouse input are transmitted in Phase 2.
- Actual desktop access requires a separate authenticated transport and per-session authorization checks.
