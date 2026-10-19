# SoloOne phone gateway

This service sends WhatsApp messages from Android phones (Multilogin cloud phones or physical phones) for numbers the backend marks with `outgoing_transport = 'phone_gateway'`. The decision is workspace RFC-006.

## Context and scope

- `docs/features/phone-gateway.md` holds the PGW-* contracts. The backend side is `soloone-backend/docs/features/phone-gateway-transport.md`.
- The backend owns messages, the outgoing queue and incoming webhooks. This service only performs a send and reports `sent`, `failed` or `unknown`.
- Device details stay here. Do not add Multilogin, ADB or device fields to the backend.

## Safety rules

- `failed` may be reported only when Send was not pressed. Anything uncertain after Send is `unknown`.
- Guarded steps are code. An LLM never presses Send, never removes a guarded step and never activates a script.
- Real sends need an explicitly approved test number and recipient. A build or test request does not authorize sending.

## Validation

- Run `npm run build` and `npm test`.
- Device behavior needs a manual check on a test number; prefer the proposal dry-run, which stops before Send.
