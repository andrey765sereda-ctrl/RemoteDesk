# Phase 2 — Temporary pairing test

## Update and publish

1. Overlay this archive on the project directory while keeping `.git`.
2. Commit and push the changes so GitHub Pages publishes the updated client.
3. From `worker/`, run `npm.cmd install` and `npx.cmd wrangler deploy`. This applies the Durable Object migration.
4. Restart the Host with `REMOTEDESK_API_URL` set.

## End-to-end test

- Check `GET /api/health`; expected `version` is `0.2.0` and `remoteControlEnabled` remains `false`.
- Host prints a one-time code.
- Submit code on the GitHub Pages site.
- Confirm the prompt in the Host terminal.
- Browser should display that pairing was approved or rejected.

This is a security and workflow prototype only. No remote-control actions are enabled in this phase.
