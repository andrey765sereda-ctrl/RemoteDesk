# RemoteDesk protocol notes — Phase 1

## Current endpoint

`GET http://127.0.0.1:47831/health`

Example response:

```json
{
  "app": "RemoteDesk Host",
  "status": "ok",
  "version": "0.1.0",
  "capabilities": ["health-check"],
  "remote_control_enabled": false
}
```

## Planned protocol constraints

- All remote-control sessions must be authenticated and explicitly authorized.
- Do not expose the Phase 1 host HTTP endpoint to a LAN or the public internet.
- WebRTC media and data channels will be negotiated through an authenticated signaling service.
- Session tokens must be short-lived and scoped to one device and one session.
- Commands should use an explicit allowlist and include sequence/session identifiers.
- The host must reject unauthenticated input events and stale/replayed commands.
