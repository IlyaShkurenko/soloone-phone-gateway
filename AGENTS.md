# SoloOne phone gateway

This service sends WhatsApp messages from Android phones (Multilogin cloud phones or physical phones) for numbers the backend marks with `outgoing_transport = 'phone_gateway'`. The decision is workspace RFC-006.

## Context and scope

- `docs/features/phone-gateway.md` holds the PGW-* contracts. The backend side is `soloone-backend/docs/features/phone-gateway-transport.md`.
- The backend owns messages, the outgoing queue and incoming webhooks. This service performs a send and reports `sent`, `failed` or `unknown`, and reports what a physical phone shows about incoming messages and ticks (workspace RFC-012, PGW-23 – PGW-30).
- Device details stay here. Do not add Multilogin, ADB or device fields to the backend.

## Safety rules

- `failed` may be reported only when Send was not pressed. Anything uncertain after Send is `unknown`.
- Guarded steps are code. An LLM never presses Send, never removes a guarded step and never activates a script.
- Real sends need an explicitly approved test number and recipient. A build or test request does not authorize sending.

## Validation

- Run `npm run build` and `npm run gate` (see "Quality and security gate" below).
- Device behavior needs a manual check on a test number; prefer the proposal dry-run, which stops before Send.

## Quality and security gate

These rules apply to every change, by a person or an agent. `.claude/README.md` describes the agents and the guard
that enforce them.

- **Done means the gate is green.** `npm run gate` runs the type check, every test and the secret scan (no linter
  is set up yet). Run the whole gate, not just the test file you touched: a fix in one place must not break another.
  CI runs the same gate before every deploy, and a red gate stops the deploy.
- **Test first.** A feature or a bug fix starts with a test of the behavior that fails on the current code
  (`npm run fails-first -- <files>`), then the code that makes it pass. A bug fix always comes with the test that
  reproduces the bug.
- **Who writes what.** For anything beyond a one-line fix, the `test-writer` agent writes the tests and the `builder`
  agent writes the code; the builder doesn't change the tests. The `verifier` checks the result. Changes to sign-in,
  payments, wallets, deposits, personal data, webhooks or secrets also get the `security-reviewer`, and their tests
  get 2 to 4 `critic` runs.
- **Secrets.** Never open, print or commit `.env` files or keys. Configuration is read by variable name; the names are
  in `.env.example` and SECURITY.md. A secret that reached git is rotated, not just deleted.
- **Test data is fictional.** Emails at example.com or example.test, phones 447700900000 to 447700900999, invented
  names. No real customer, creator or phone number in code, tests, fixtures or docs.
- **Logs** carry IDs and outcomes, never tokens, message text, phone numbers or emails.
