# RemoteDesk protocol notes

## Pairing

- `POST /api/pairing/start` — Host registers a one-time code; payload has `sessionId`, `hostSecret`, `pairCode`.
- `POST /api/pairing/claim` — browser claims a code and receives ephemeral `clientToken`.
- `POST /api/pairing/host-status` — Host polls pairing state.
- `POST /api/pairing/decision` — Host approves/rejects the pending request.
- `POST /api/pairing/client-status` — browser polls pairing state.

## WebRTC signaling (Phase 3)

SDP descriptions are JSON-serialized `RTCSessionDescription` values passed as a string in `description`. These endpoints are accepted only after the pairing session is approved:

- `POST /api/rtc/host-offer` — Host-secret authenticated; stores the Host offer.
- `POST /api/rtc/client-offer` — client-token authenticated; returns `waiting` or the offer.
- `POST /api/rtc/client-answer` — client-token authenticated; stores the browser answer.
- `POST /api/rtc/host-answer` — Host-secret authenticated; returns `waiting` or the answer.

The Host creates a `screen-frames` DataChannel. Each binary message begins with an 8-byte header: `frame_id` (unsigned 32-bit big-endian), `chunk_index` (unsigned 16-bit big-endian), `chunk_count` (unsigned 16-bit big-endian), followed by JPEG data. The browser reassembles all chunks for a frame before displaying it.

## Current non-capabilities

- No mouse or keyboard input messages exist.
- No clipboard or file transfer.
- No TURN relay configured yet.
- This is a low-rate JPEG preview, not an H.264 encoded video stream.
