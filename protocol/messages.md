# RemoteDesk protocol notes

## Pairing

- `POST /api/pairing/start` — Host registers a one-time code; payload has `sessionId`, `hostSecret`, `pairCode`.
- `POST /api/pairing/claim` — browser claims a code and receives ephemeral `clientToken`.
- `POST /api/pairing/host-status` — Host polls pairing state.
- `POST /api/pairing/decision` — Host approves/rejects the pending request.
- `POST /api/pairing/client-status` — browser polls pairing state.

## WebRTC signaling (current)

SDP descriptions are JSON-serialized `RTCSessionDescription` values passed as a string in `description`. These endpoints are accepted only after the pairing session is approved:

- `POST /api/rtc/host-offer` — Host-secret authenticated; stores the Host offer.
- `POST /api/rtc/client-offer` — client-token authenticated; returns `waiting` or the offer.
- `POST /api/rtc/client-answer` — client-token authenticated; stores the browser answer.
- `POST /api/rtc/host-answer` — Host-secret authenticated; returns `waiting` or the answer.

The Host negotiates a native `video/H264` RTP media track. Windows captures RGB frames, encodes them with OpenH264 in Annex-B H.264 format, and writes each encoded access unit as a WebRTC media sample. The browser selects H.264 for the video transceiver and renders the remote track in a `<video>` element. No image chunks are sent over a DataChannel.

## Current non-capabilities

- No mouse or keyboard input messages exist.
- No clipboard or file transfer.
- No TURN relay configured yet.
- The current transport is H.264 video encoded in software by OpenH264, with STUN-only connectivity and no TURN relay.
